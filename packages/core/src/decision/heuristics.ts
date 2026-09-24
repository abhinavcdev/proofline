import type { QuestionSet } from "@proofline/questions";
import { extractFeatures, templatedTextScore, type Feature } from "../features.js";
import type { Answer, Answers } from "../types/answers.js";
import type { State } from "../types/state.js";

/**
 * Deterministic, feature-based answers. Not a model. Powers MockProvider
 * (tests/local dev) and RulesOnlyProvider (degraded mode), which differ only
 * in how much confidence they claim.
 */

const BIAS = -1.6;

export interface HeuristicProfile {
  /** Upper bound on any reported confidence. */
  maxConfidence: number;
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const round = (x: number) => Math.round(x * 1000) / 1000;

export function automationProbability(state: State, features: Feature[] = extractFeatures(state)): number {
  const sum = features.reduce((s, f) => s + f.weight, BIAS);
  return round(sigmoid(sum));
}

type BotLabel = "scraper" | "spam_bot" | "credential_stuffer" | "farm_account";

function likelyBot(state: State, features: Feature[]): BotLabel {
  const tally: Record<BotLabel, number> = { scraper: 0.1, spam_bot: 0, credential_stuffer: 0, farm_account: 0 };
  for (const f of features) for (const h of f.hints ?? []) tally[h] += Math.max(f.weight, 0.1);
  if (state.event === "login") tally.credential_stuffer += 1;
  if (state.event === "signup") tally.farm_account += 0.8;
  if (state.event === "comment" || state.event === "form_submit") tally.spam_bot += state.text ? 0.8 : 0.2;
  return (Object.entries(tally) as [BotLabel, number][]).sort((a, b) => b[1] - a[1])[0]![0];
}

const INTENT_FOR: Record<string, string> = {
  human: "normal_use",
  declared_agent: "normal_use",
  scraper: "data_harvesting",
  spam_bot: "spam",
  credential_stuffer: "account_takeover",
  farm_account: "fraud",
};

/** Put `mass` on `label`, spread the rest evenly across other labels. */
function peaked(labels: readonly string[], label: string, mass: number): Record<string, number> {
  const rest = (1 - mass) / (labels.length - 1);
  return Object.fromEntries(labels.map((l) => [l, round(l === label ? mass : rest)]));
}

function choice(probs: Record<string, number>, maxConf: number): Answer {
  const [label, p] = Object.entries(probs).sort((a, b) => b[1] - a[1])[0]!;
  return { type: "choice", label, probs, confidence: round(Math.min(p, maxConf)) };
}

function noul(p: number, maxConf: number): Answer {
  return {
    type: "noul",
    p,
    confidence: round(Math.min(0.5 + 0.5 * Math.abs(2 * p - 1), maxConf)),
    confidence_derived: false,
  };
}

function score(center: number, levels: number, maxConf: number): Answer {
  const weights = Array.from({ length: levels }, (_, i) => Math.exp(-2.2 * Math.abs(i - center)));
  const total = weights.reduce((s, w) => s + w, 0);
  const probs = weights.map((w) => round(w / total));
  const value = probs.indexOf(Math.max(...probs));
  return { type: "score", value, probs, confidence: round(Math.min(probs[value]!, maxConf)) };
}

export function heuristicAnswers(
  state: State,
  set: QuestionSet,
  askedKeys: readonly string[],
  profile: HeuristicProfile,
): Answers {
  const features = extractFeatures(state);
  const verifiedAgent = state.network?.declared_agent?.startsWith("verified:") ?? false;
  const pAuto = verifiedAgent ? 0.97 : automationProbability(state, features);
  const actor = verifiedAgent ? "declared_agent" : pAuto < 0.35 ? "human" : likelyBot(state, features);
  const riskCenter = verifiedAgent ? 0.3 : Math.min(3, pAuto * 3.3);
  const maxConf = profile.maxConfidence;

  const out: Answers = {};
  for (const key of askedKeys) {
    const q = set.questions.find((x) => x.key === key);
    if (!q) continue;
    if (q.type === "noul") {
      const p = key === "content_is_templated" && state.text ? round(0.08 + 0.84 * templatedTextScore(state.text.excerpt)) : pAuto;
      out[key] = noul(p, maxConf);
    } else if (q.type === "score") {
      out[key] = score(riskCenter, q.legend.length, maxConf);
    } else {
      const labels = q.options.map((o) => o.label);
      const target = key === "intent" ? (state.event === "checkout" && actor !== "human" && actor !== "declared_agent" ? "fraud" : INTENT_FOR[actor]) : actor;
      if (target && labels.includes(target)) {
        const mass = target === "human" || target === "normal_use" ? Math.max(1 - pAuto, 0.4) : 0.45 + 0.5 * pAuto;
        out[key] = choice(peaked(labels, target, round(mass)), maxConf);
      } else {
        out[key] = choice(peaked(labels, labels[0]!, 1 / labels.length + 0.01), maxConf);
      }
    }
  }
  return out;
}
