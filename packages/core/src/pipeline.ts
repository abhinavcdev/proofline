import type { QuestionSet } from "@proofline/questions";
import { decideWithFallback, type DecisionProvider, type DecisionSource } from "./decision/provider.js";
import { evaluatePolicy } from "./policy/engine.js";
import { applyMode } from "./policy/mode.js";
import type { Answers } from "./types/answers.js";
import type { Mode } from "./types/events.js";
import type { Capabilities, DeterministicChecks, EventPolicy, FinalDecision } from "./types/policy.js";
import type { State } from "./types/state.js";

export interface DecideInput {
  state: State;
  checks: DeterministicChecks;
  policy: EventPolicy;
  capabilities: Capabilities;
  mode: Mode;
  questions: QuestionSet;
  provider: DecisionProvider;
  fallback: DecisionProvider;
  timeoutMs: number;
  now?: () => number;
}

export interface DecideOutput {
  decision: FinalDecision;
  answers: Answers;
  asked: string[];
  /** `none` when a deterministic hard block made the model call unnecessary. */
  source: DecisionSource | "none";
  fallback_reason?: "timeout" | "error" | "invalid_response";
  questions_version: string;
  policy_version: number;
  timings: { decide_ms: number; policy_ms: number };
}

const HARD_TOKEN = new Set(["invalid", "replayed"]);
const HARD_POW = new Set(["failed", "replayed"]);

export function isHardBlocked(c: DeterministicChecks): boolean {
  return HARD_TOKEN.has(c.token) || HARD_POW.has(c.pow) || c.known_bad_ip || c.rate_limited.length > 0;
}

/** Decide → policy → mode. Hard-blocked events skip the model call entirely. */
export async function decide(input: DecideInput): Promise<DecideOutput> {
  const now = input.now ?? (() => performance.now());
  const t0 = now();

  let answers: Answers = {};
  let asked: string[] = [];
  let source: DecideOutput["source"] = "none";
  let fallbackReason: DecideOutput["fallback_reason"];

  if (!isHardBlocked(input.checks)) {
    const r = await decideWithFallback(input.provider, input.fallback, input.state, input.questions, {
      timeoutMs: input.timeoutMs,
      now,
    });
    answers = r.answers;
    asked = r.asked;
    source = r.source;
    fallbackReason = r.fallback_reason;
  }
  const t1 = now();

  const policyDecision = evaluatePolicy({
    answers,
    checks: input.checks,
    policy: input.policy,
    state: input.state,
    capabilities: input.capabilities,
  });
  if (source === "fallback") {
    policyDecision.reasons.push({
      code: "degraded",
      message: `The AI assessment was unavailable (${fallbackReason ?? "error"}); decided with rules only`,
    });
  }
  const decision = applyMode(policyDecision, input.mode);
  const t2 = now();

  return {
    decision,
    answers,
    asked,
    source,
    ...(fallbackReason ? { fallback_reason: fallbackReason } : {}),
    questions_version: input.questions.version,
    policy_version: input.policy.version,
    timings: { decide_ms: round1(t1 - t0), policy_ms: round1(t2 - t1) },
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
