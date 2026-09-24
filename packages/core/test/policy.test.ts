import { describe, expect, it } from "vitest";
import {
  DEFAULT_CAPABILITIES,
  EventType,
  applyMode,
  buildState,
  conditionHolds,
  defaultPolicy,
  deriveNoulConfidence,
  evaluatePolicy,
  resolveAction,
  severity,
  type Answers,
  type Capabilities,
  type DeterministicChecks,
  type EventPolicy,
} from "../src/index.js";
import { humanBrowser, humanEdge, okChecks } from "./fixtures.js";

/** Answers builder: v1 questions with sensible defaults. */
function answers(o: {
  pAuto?: number;
  autoConf?: number;
  actor?: string;
  actorConf?: number;
  risk?: 0 | 1 | 2 | 3;
  riskConf?: number;
  intent?: string;
  intentConf?: number;
  templated?: number;
}): Answers {
  const pAuto = o.pAuto ?? 0.05;
  const risk = o.risk ?? 0;
  const actor = o.actor ?? "human";
  const intent = o.intent ?? "normal_use";
  const riskProbs = [0, 1, 2, 3].map((i) => (i === risk ? 0.7 : 0.1));
  const out: Answers = {
    is_automated: { type: "noul", p: pAuto, confidence: o.autoConf ?? 0.95, confidence_derived: false },
    actor_type: { type: "choice", label: actor, probs: { [actor]: 0.9 }, confidence: o.actorConf ?? 0.9 },
    risk_level: { type: "score", value: risk, probs: riskProbs, confidence: o.riskConf ?? 0.9 },
    intent: { type: "choice", label: intent, probs: { [intent]: 0.9 }, confidence: o.intentConf ?? 0.9 },
  };
  if (o.templated !== undefined) {
    out.content_is_templated = { type: "noul", p: o.templated, confidence: 0.9, confidence_derived: false };
  }
  return out;
}

const humanState = buildState({ event: "signup", token: "valid", browser: humanBrowser, edge: humanEdge });
const caps: Capabilities = { passkey: true, email: true, id_verify: false };

function run(
  a: Answers,
  opts: { checks?: Partial<DeterministicChecks>; policy?: EventPolicy; capabilities?: Capabilities; event?: EventType } = {},
) {
  const event = opts.event ?? "signup";
  return evaluatePolicy({
    answers: a,
    checks: { ...okChecks, ...opts.checks },
    policy: opts.policy ?? defaultPolicy(event),
    state: event === humanState.event ? humanState : { ...humanState, event },
    capabilities: opts.capabilities ?? caps,
  });
}

describe("policy engine: spec thresholds", () => {
  it("allows when is_automated < 0.2 with confidence ≥ 0.8", () => {
    const d = run(answers({ pAuto: 0.1, autoConf: 0.85 }));
    expect(d.action).toBe("allow");
    expect(d.matched).toBe("allow_confident_human");
  });

  it("blocks when is_automated > 0.9 with confidence ≥ 0.9", () => {
    const d = run(answers({ pAuto: 0.95, autoConf: 0.92, actor: "scraper", risk: 3 }));
    expect(d.action).toBe("block");
    expect(d.matched).toBe("block_confident_automation");
  });

  it("does not block on high probability with low confidence", () => {
    const d = run(answers({ pAuto: 0.95, autoConf: 0.6, actor: "scraper", risk: 2, riskConf: 0.6 }));
    expect(d.action).not.toBe("block");
  });

  it("steps up one rung when risk ≥ 2 with confidence < 0.7", () => {
    const d = run(answers({ pAuto: 0.5, autoConf: 0.5, risk: 2, riskConf: 0.6 }));
    expect(d.matched).toBe("step_up_uncertain_risk");
    expect(d.action).toBe("step_up:pow");
  });

  it("treats the boundaries exactly as specified", () => {
    expect(run(answers({ pAuto: 0.2, autoConf: 0.99 })).matched).not.toBe("allow_confident_human");
    expect(run(answers({ pAuto: 0.19, autoConf: 0.8 })).matched).toBe("allow_confident_human");
    expect(run(answers({ pAuto: 0.9, autoConf: 0.99, risk: 3 })).matched).not.toBe("block_confident_automation");
    expect(run(answers({ pAuto: 0.91, autoConf: 0.9, risk: 3 })).matched).toBe("block_confident_automation");
  });

  it("falls back to default_by_risk when no rule matches", () => {
    const low = run(answers({ pAuto: 0.3, autoConf: 0.7, risk: 1 }));
    expect(low).toMatchObject({ action: "allow", matched: "default_by_risk", risk: 1 });
    const high = run(answers({ pAuto: 0.8, autoConf: 0.8, risk: 3, riskConf: 0.8 }));
    expect(high).toMatchObject({ action: "step_up:passkey", matched: "default_by_risk", risk: 3 });
  });
});

describe("policy engine: deterministic checks always win", () => {
  const confidentHuman = answers({ pAuto: 0.01, autoConf: 0.99 });

  it.each<[string, Partial<DeterministicChecks>]>([
    ["token_invalid", { token: "invalid" }],
    ["token_replayed", { token: "replayed" }],
    ["pow_failed", { pow: "failed" }],
    ["pow_replayed", { pow: "replayed" }],
    ["known_bad_ip", { known_bad_ip: true }],
    ["rate_limited", { rate_limited: ["ip"] }],
  ])("%s → block even when the model is confident it's human", (code, checks) => {
    const d = run(confidentHuman, { checks });
    expect(d.action).toBe("block");
    expect(d.matched).toBe(`hard:${code}`);
    expect(d.risk).toBe(3);
    expect(d.reasons[0]?.code).toBe(code);
  });

  it("hard checks beat a verified declared agent", () => {
    const d = run(confidentHuman, { checks: { declared_agent: "verified", rate_limited: ["fingerprint"] } });
    expect(d.action).toBe("block");
  });

  it("blocks with no answers at all (model skipped)", () => {
    expect(run({}, { checks: { known_bad_ip: true } }).action).toBe("block");
  });
});

describe("policy engine: lanes, floors and ladders", () => {
  it("routes verified declared agents to the agent lane", () => {
    const d = run(answers({ pAuto: 0.99, autoConf: 0.99, actor: "declared_agent" }), { checks: { declared_agent: "verified" } });
    expect(d.action).toBe("agent_lane");
    expect(d.matched).toBe("declared_agent");
  });

  it("an unverified agent claim does not get the agent lane", () => {
    const d = run(answers({ pAuto: 0.95, autoConf: 0.95, actor: "scraper" }), { checks: { declared_agent: "unverified_claim" } });
    expect(d.action).toBe("block");
  });

  it("missing token raises allow to at least proof-of-work", () => {
    const d = run(answers({ pAuto: 0.05, autoConf: 0.95 }), { checks: { token: "missing" } });
    expect(d.action).toBe("step_up:pow");
    expect(d.matched).toBe("missing_token");
  });

  it("missing token never lowers a stronger action", () => {
    const d = run(answers({ pAuto: 0.97, autoConf: 0.95 }), { checks: { token: "missing" } });
    expect(d.action).toBe("block");
  });

  it("credential stuffing climbs past unavailable rungs", () => {
    const a = answers({ pAuto: 0.7, autoConf: 0.7, actor: "credential_stuffer", actorConf: 0.8, risk: 2, riskConf: 0.8 });
    expect(run(a, { event: "login" }).action).toBe("step_up:passkey");
    expect(run(a, { event: "login", capabilities: { passkey: false, email: true, id_verify: false } }).action).toBe("step_up:email_otp");
    expect(run(a, { event: "login", capabilities: DEFAULT_CAPABILITIES }).action).toBe("step_up:review");
  });

  it("farm-account signups get email OTP", () => {
    const a = answers({ pAuto: 0.8, autoConf: 0.8, actor: "farm_account", actorConf: 0.75, risk: 2, riskConf: 0.8 });
    expect(run(a).action).toBe("step_up:email_otp");
  });

  it("checkout fraud intent steps up two rungs", () => {
    const a = answers({ pAuto: 0.4, autoConf: 0.7, intent: "fraud", intentConf: 0.8, risk: 2, riskConf: 0.8 });
    expect(run(a, { event: "checkout" })).toMatchObject({ action: "step_up:passkey", matched: "checkout_fraud" });
  });

  it("confident spam on comments is shadow-dropped, but not on login", () => {
    const a = answers({ pAuto: 0.85, autoConf: 0.85, actor: "spam_bot", actorConf: 0.9, risk: 2, riskConf: 0.8, intent: "spam" });
    expect(run(a, { event: "comment" }).action).toBe("shadow_drop");
    expect(run(a, { event: "login" }).action).not.toBe("shadow_drop");
  });

  it("templated text from likely automation is shadow-dropped", () => {
    const a = answers({ pAuto: 0.7, autoConf: 0.6, actor: "scraper", actorConf: 0.5, risk: 2, riskConf: 0.8, templated: 0.95 });
    expect(run(a, { event: "form_submit" }).matched).toBe("drop_templated_automated_text");
  });

  it("resolveAction handles explicit rungs, levels and fallbacks", () => {
    expect(resolveAction({ action: "block" }, caps)).toBe("block");
    expect(resolveAction({ action: "step_up" }, caps)).toBe("step_up:pow");
    expect(resolveAction({ action: "step_up", level: 3 }, caps)).toBe("step_up:email_otp");
    expect(resolveAction({ action: "step_up", rung: "id_verify" }, caps)).toBe("step_up:review");
    expect(resolveAction({ action: "step_up", rung: "id_verify" }, { ...caps, id_verify: true })).toBe("step_up:id_verify");
  });

  it("severity orders actions by friction", () => {
    const ordered = ["allow", "agent_lane", "step_up:pow", "step_up:passkey", "step_up:email_otp", "step_up:review", "shadow_drop", "block"] as const;
    for (let i = 1; i < ordered.length; i++) expect(severity(ordered[i]!)).toBeGreaterThan(severity(ordered[i - 1]!));
  });
});

describe("conditions", () => {
  const a = answers({ pAuto: 0.3, actor: "scraper" });
  it("evaluates prob/label/score/confidence and is false for missing questions", () => {
    expect(conditionHolds({ type: "prob", q: "is_automated", op: "lt", value: 0.5 }, a)).toBe(true);
    expect(conditionHolds({ type: "prob", q: "actor_type", label: "scraper", op: "gte", value: 0.9 }, a)).toBe(true);
    expect(conditionHolds({ type: "prob", q: "actor_type", op: "gte", value: 0.1 }, a)).toBe(false);
    expect(conditionHolds({ type: "label", q: "actor_type", in: ["human"] }, a)).toBe(false);
    expect(conditionHolds({ type: "score", q: "risk_level", op: "lte", value: 0 }, a)).toBe(true);
    expect(conditionHolds({ type: "confidence", q: "intent", op: "gt", value: 0.5 }, a)).toBe(true);
    expect(conditionHolds({ type: "prob", q: "content_is_templated", op: "gt", value: 0 }, a)).toBe(false);
  });

  it("derived noul confidence is distance from 0.5", () => {
    expect(deriveNoulConfidence(0.5)).toBe(0);
    expect(deriveNoulConfidence(0.05)).toBeCloseTo(0.9);
    expect(deriveNoulConfidence(0.95)).toBeCloseTo(0.9);
  });
});

describe("explainability", () => {
  it("every non-allow decision has a human-readable primary reason and model evidence", () => {
    const cases: Answers[] = [
      answers({ pAuto: 0.95, autoConf: 0.95, risk: 3 }),
      answers({ pAuto: 0.5, autoConf: 0.5, risk: 2, riskConf: 0.6 }),
      answers({ pAuto: 0.8, autoConf: 0.8, risk: 3, riskConf: 0.8 }),
    ];
    for (const a of cases) {
      const d = run(a);
      expect(d.action).not.toBe("allow");
      expect(d.reasons[0]?.message.length).toBeGreaterThan(10);
      const model = d.reasons.find((r) => r.code === "model");
      expect(model?.message).toMatch(/likely automated/);
      expect(model?.evidence?.p_automated).toBe(a.is_automated?.type === "noul" ? a.is_automated.p : undefined);
    }
  });

  it("includes the top suspicious signals from the state", () => {
    const botState = buildState({
      event: "signup",
      token: "valid",
      browser: { ...humanBrowser, page_ms: 500, automation: { webdriver: true, headless_hints: [], viewport_consistent: true } },
    });
    const d = evaluatePolicy({
      answers: answers({ pAuto: 0.95, autoConf: 0.95, risk: 3 }),
      checks: okChecks,
      policy: defaultPolicy("signup"),
      state: botState,
      capabilities: caps,
    });
    const codes = d.reasons.map((r) => r.code);
    expect(codes).toContain("webdriver");
    expect(codes).toContain("instant_submit");
  });

  it("allow decisions cite human-like signals", () => {
    const d = run(answers({ pAuto: 0.05, autoConf: 0.95 }));
    expect(d.reasons.some((r) => (r.weight ?? 0) < 0)).toBe(true);
  });
});

describe("applyMode", () => {
  it("shadow always allows and keeps the would-be action", () => {
    const d = run(answers({ pAuto: 0.99, autoConf: 0.99 }));
    const f = applyMode(d, "shadow");
    expect(f.action).toBe("block");
    expect(f.effective_action).toBe("allow");
  });

  it("enforce passes the action through", () => {
    const d = run(answers({ pAuto: 0.99, autoConf: 0.99 }));
    expect(applyMode(d, "enforce").effective_action).toBe("block");
  });
});

describe("default policies", () => {
  it("parse for every event type", () => {
    for (const e of EventType.options) expect(defaultPolicy(e).event_type).toBe(e);
  });
});
