import { extractFeatures, topFeatures, type Feature } from "../features.js";
import { LADDER, stepUp, type Action, type Rung } from "../types/events.js";
import type { Answer, Answers } from "../types/answers.js";
import type {
  ActionSpec,
  Capabilities,
  Cmp,
  Condition,
  DeterministicChecks,
  EventPolicy,
  PolicyDecision,
  Reason,
} from "../types/policy.js";
import type { State } from "../types/state.js";

export interface PolicyInput {
  answers: Answers;
  checks: DeterministicChecks;
  policy: EventPolicy;
  state: State;
  capabilities: Capabilities;
}

export const DEFAULT_CAPABILITIES: Capabilities = { passkey: false, email: false, id_verify: false };

/**
 * Evaluate a policy. Order:
 *  1. deterministic hard checks → block (model output can't override)
 *  2. verified declared agent   → policy.declared_agent
 *  3. rules, first match wins
 *  4. default_by_risk
 *  then the missing/expired-token floor is applied.
 */
export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  const { answers, checks, policy, state, capabilities } = input;
  const features = extractFeatures(state);

  const hard = hardBlock(checks);
  if (hard) {
    return {
      action: "block",
      risk: 3,
      matched: `hard:${hard.code}`,
      reasons: [hard, ...featureReasons(features, "block"), ...modelReason(answers)],
    };
  }

  const risk = riskOf(answers);

  if (checks.declared_agent === "verified") {
    const action = resolveAction(policy.declared_agent, capabilities);
    return {
      action,
      risk,
      matched: "declared_agent",
      reasons: [
        { code: "declared_agent", message: "Verified, self-identified agent; routed by the agent policy", weight: 0 },
        ...modelReason(answers),
      ],
    };
  }

  let action: Action;
  let matched: string;
  let primary: Reason;
  const rule = policy.rules.find((r) => r.when.every((c) => conditionHolds(c, answers)));
  if (rule) {
    action = resolveAction(rule.then, capabilities);
    matched = rule.id;
    primary = { code: `rule:${rule.id}`, message: rule.explain };
  } else {
    action = resolveAction(policy.default_by_risk[risk], capabilities);
    matched = "default_by_risk";
    primary = { code: "default_by_risk", message: `No specific rule matched; applied the default for risk level ${risk}` };
  }

  if (checks.token === "missing" || checks.token === "expired") {
    const floor = resolveAction(policy.missing_token, capabilities);
    if (severity(floor) > severity(action)) {
      action = floor;
      matched = "missing_token";
      primary = {
        code: "missing_token",
        message:
          checks.token === "missing"
            ? "No browser signals were received, so a light check is required"
            : "The browser signal token had expired, so a light check is required",
      };
    }
  }

  return { action, risk, matched, reasons: [primary, ...featureReasons(features, action), ...modelReason(answers)] };
}

function hardBlock(c: DeterministicChecks): Reason | undefined {
  if (c.token === "invalid") return { code: "token_invalid", message: "The browser signal token was forged or tampered with", weight: 10 };
  if (c.token === "replayed") return { code: "token_replayed", message: "The browser signal token was reused", weight: 10 };
  if (c.pow === "failed") return { code: "pow_failed", message: "The proof-of-work solution was wrong", weight: 10 };
  if (c.pow === "replayed") return { code: "pow_replayed", message: "The proof-of-work solution was reused", weight: 10 };
  if (c.known_bad_ip) return { code: "known_bad_ip", message: "The network address is on a known-abuse list", weight: 10 };
  if (c.rate_limited.length)
    return {
      code: "rate_limited",
      message: `Hard rate limit exceeded (${c.rate_limited.join(", ")})`,
      weight: 10,
      evidence: { limits: c.rate_limited.join(",") },
    };
  return undefined;
}

export function riskOf(answers: Answers): 0 | 1 | 2 | 3 {
  const r = answers.risk_level;
  if (r?.type === "score") return clampRisk(r.value);
  const auto = answers.is_automated;
  if (auto?.type === "noul") return clampRisk(Math.round(auto.p * 3));
  return 1;
}

const clampRisk = (n: number) => Math.max(0, Math.min(3, Math.round(n))) as 0 | 1 | 2 | 3;

function compare(a: number, op: Cmp, b: number): boolean {
  switch (op) {
    case "lt":
      return a < b;
    case "lte":
      return a <= b;
    case "gt":
      return a > b;
    case "gte":
      return a >= b;
  }
}

export function conditionHolds(c: Condition, answers: Answers): boolean {
  const a: Answer | undefined = answers[c.q];
  if (!a) return false;
  switch (c.type) {
    case "prob":
      if (a.type === "noul") return compare(a.p, c.op, c.value);
      if (a.type === "choice" && c.label !== undefined) return compare(a.probs[c.label] ?? 0, c.op, c.value);
      return false;
    case "label":
      return a.type === "choice" && c.in.includes(a.label);
    case "score":
      return a.type === "score" && compare(a.value, c.op, c.value);
    case "confidence":
      return compare(a.confidence, c.op, c.value);
  }
}

/** Resolve a spec to a concrete action, climbing past rungs the user can't complete. */
export function resolveAction(spec: ActionSpec, caps: Capabilities): Action {
  if (spec.action !== "step_up") return spec.action;
  const start = spec.rung ? LADDER.indexOf(spec.rung) : (spec.level ?? 1) - 1;
  for (let i = Math.max(0, start); i < LADDER.length; i++) {
    const rung = LADDER[i]!;
    if (rungAvailable(rung, caps)) return stepUp(rung);
  }
  return stepUp("review");
}

export function rungAvailable(rung: Rung, caps: Capabilities): boolean {
  switch (rung) {
    case "pow":
    case "review":
      return true;
    case "passkey":
      return caps.passkey;
    case "email_otp":
      return caps.email;
    case "id_verify":
      return caps.id_verify;
  }
}

/** Friction ordering used for floors: allow < agent_lane < step-ups (by rung) < shadow_drop < block. */
export function severity(action: Action): number {
  if (action === "allow") return 0;
  if (action === "agent_lane") return 1;
  if (action === "shadow_drop") return 20;
  if (action === "block") return 30;
  return 10 + LADDER.indexOf(action.slice("step_up:".length) as Rung);
}

function featureReasons(features: Feature[], action: Action): Reason[] {
  const toReason = (f: Feature): Reason => ({ code: f.code, message: f.message, weight: f.weight });
  if (action === "allow" || action === "agent_lane") {
    const humanLike = features.filter((f) => f.weight < 0).sort((a, b) => a.weight - b.weight);
    return humanLike.slice(0, 3).map(toReason);
  }
  return topFeatures(features.filter((f) => f.weight > 0), 4).map(toReason);
}

const pct = (p: number) => `${Math.round(p * 100)}%`;

function modelReason(answers: Answers): Reason[] {
  const parts: string[] = [];
  const evidence: Record<string, number | string> = {};
  const auto = answers.is_automated;
  if (auto?.type === "noul") {
    parts.push(`${pct(auto.p)} likely automated`);
    evidence.p_automated = auto.p;
    evidence.automated_confidence = auto.confidence;
  }
  const actor = answers.actor_type;
  if (actor?.type === "choice") {
    parts.push(`most likely ${actor.label.replace(/_/g, " ")} (${pct(actor.probs[actor.label] ?? 0)})`);
    evidence.actor_type = actor.label;
    evidence.actor_confidence = actor.confidence;
  }
  const risk = answers.risk_level;
  if (risk?.type === "score") {
    parts.push(`risk ${["safe", "low", "elevated", "high"][risk.value] ?? risk.value} (confidence ${risk.confidence.toFixed(2)})`);
    evidence.risk_level = risk.value;
    evidence.risk_confidence = risk.confidence;
  }
  const tmpl = answers.content_is_templated;
  if (tmpl?.type === "noul") {
    parts.push(`${pct(tmpl.p)} likely templated text`);
    evidence.p_templated = tmpl.p;
  }
  const intent = answers.intent;
  if (intent?.type === "choice") {
    parts.push(`intent ${intent.label.replace(/_/g, " ")}`);
    evidence.intent = intent.label;
  }
  if (!parts.length) return [];
  return [{ code: "model", message: `Assessment: ${parts.join("; ")}`, evidence }];
}
