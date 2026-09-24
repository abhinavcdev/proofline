import { getQuestionSet } from "@proofline/questions";
import { describe, expect, it } from "vitest";
import {
  EventType,
  MockProvider,
  PowStatus,
  RulesOnlyProvider,
  TokenStatus,
  applyMode,
  buildState,
  decide,
  defaultPolicy,
  evaluatePolicy,
  type Answers,
  type DecisionProvider,
  type DeterministicChecks,
} from "../src/index.js";
import { agentEdge, headlessBrowser, humanBrowser, humanEdge, swarmEdge } from "./fixtures.js";

/**
 * Shadow mode must never block. These tests push randomised checks, states
 * and model answers through the policy and the full pipeline and assert the
 * effective action is always `allow`.
 */

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

function randomChecks(r: () => number): DeterministicChecks {
  return {
    token: pick(r, TokenStatus.options),
    pow: pick(r, PowStatus.options),
    rate_limited: r() < 0.3 ? [pick(r, ["ip", "asn", "fingerprint", "api_key"] as const)] : [],
    known_bad_ip: r() < 0.2,
    declared_agent: pick(r, ["none", "verified", "unverified_claim"] as const),
  };
}

function randomAnswers(r: () => number): Answers {
  const actor = pick(r, ["human", "declared_agent", "scraper", "spam_bot", "credential_stuffer", "farm_account"]);
  const intent = pick(r, ["normal_use", "data_harvesting", "fraud", "spam", "account_takeover"]);
  const risk = Math.floor(r() * 4);
  return {
    is_automated: { type: "noul", p: r(), confidence: r(), confidence_derived: false },
    actor_type: { type: "choice", label: actor, probs: { [actor]: 1 }, confidence: r() },
    risk_level: { type: "score", value: risk, probs: [0, 1, 2, 3].map((i) => (i === risk ? 1 : 0)), confidence: r() },
    intent: { type: "choice", label: intent, probs: { [intent]: 1 }, confidence: r() },
    content_is_templated: { type: "noul", p: r(), confidence: r(), confidence_derived: false },
  };
}

describe("shadow mode never blocks", () => {
  it("policy + applyMode over 5,000 random inputs", () => {
    const r = rng(42);
    let wouldHaveBlocked = 0;
    for (let i = 0; i < 5_000; i++) {
      const event = pick(r, EventType.options);
      const state = buildState({
        event,
        token: "valid",
        browser: pick(r, [humanBrowser, headlessBrowser, undefined]),
        edge: pick(r, [humanEdge, swarmEdge, agentEdge]),
        server: r() < 0.5 ? { text: "buy cheap seo backlinks https://a.example https://b.example" } : {},
      });
      const d = evaluatePolicy({
        answers: randomAnswers(r),
        checks: randomChecks(r),
        policy: defaultPolicy(event),
        state,
        capabilities: { passkey: r() < 0.5, email: r() < 0.5, id_verify: r() < 0.5 },
      });
      if (d.action !== "allow") wouldHaveBlocked++;
      const f = applyMode(d, "shadow");
      expect(f.effective_action).toBe("allow");
      expect(f.action).toBe(d.action);
    }
    // Sanity: the corpus actually exercises non-allow actions.
    expect(wouldHaveBlocked).toBeGreaterThan(2_000);
  });

  it("full pipeline with mock, fallback and hard blocks", async () => {
    const set = getQuestionSet("v1");
    const failing: DecisionProvider = { name: "jev", decide: () => Promise.reject(new Error("down")) };
    const r = rng(7);
    for (let i = 0; i < 300; i++) {
      const event = pick(r, EventType.options);
      const out = await decide({
        state: buildState({ event, token: "valid", browser: pick(r, [humanBrowser, headlessBrowser]), edge: pick(r, [humanEdge, swarmEdge]) }),
        checks: randomChecks(r),
        policy: defaultPolicy(event),
        capabilities: { passkey: false, email: false, id_verify: false },
        mode: "shadow",
        questions: set,
        provider: r() < 0.5 ? new MockProvider() : failing,
        fallback: new RulesOnlyProvider(),
        timeoutMs: 400,
      });
      expect(out.decision.effective_action).toBe("allow");
      expect(out.decision.mode).toBe("shadow");
    }
  });
});
