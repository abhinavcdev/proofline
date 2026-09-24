import { getQuestionSet } from "@proofline/questions";
import { describe, expect, it, vi } from "vitest";
import {
  JevProvider,
  MockProvider,
  RulesOnlyProvider,
  askedQuestionKeys,
  buildState,
  decide,
  decideWithFallback,
  defaultPolicy,
  validateAnswers,
  type Answers,
  type DecisionProvider,
  type JevWire,
} from "../src/index.js";
import { agentEdge, headlessBrowser, humanBrowser, humanEdge, humanServer, okChecks, swarmEdge } from "./fixtures.js";

const set = getQuestionSet("v1");
const human = buildState({ event: "signup", token: "valid", browser: humanBrowser, edge: humanEdge, server: humanServer });
const bot = buildState({ event: "login", token: "valid", browser: headlessBrowser, edge: swarmEdge });
const spam = buildState({
  event: "comment",
  token: "missing",
  edge: swarmEdge,
  server: { text: "Dear webmaster, increase your traffic with cheap SEO backlinks! https://a.example https://b.example" },
});
const agent = buildState({ event: "checkout", token: "missing", edge: agentEdge });
const signal = () => new AbortController().signal;

describe("askedQuestionKeys", () => {
  it("skips content_is_templated when there is no text", () => {
    expect(askedQuestionKeys(human, set)).toEqual(["is_automated", "actor_type", "risk_level", "intent"]);
    expect(askedQuestionKeys(spam, set)).toContain("content_is_templated");
  });
});

describe("MockProvider", () => {
  const mock = new MockProvider();

  it("is deterministic and produces valid answers", async () => {
    const keys = askedQuestionKeys(spam, set);
    const a = await mock.decide(spam, set, keys, { signal: signal() });
    const b = await mock.decide(spam, set, keys, { signal: signal() });
    expect(a).toEqual(b);
    expect(() => validateAnswers(a, set, keys)).not.toThrow();
  });

  it("separates humans from bots", async () => {
    const h = await mock.decide(human, set, askedQuestionKeys(human, set), { signal: signal() });
    const b = await mock.decide(bot, set, askedQuestionKeys(bot, set), { signal: signal() });
    expect(h.is_automated).toMatchObject({ type: "noul" });
    expect(h.is_automated?.type === "noul" && h.is_automated.p).toBeLessThan(0.1);
    expect(b.is_automated?.type === "noul" && b.is_automated.p).toBeGreaterThan(0.95);
    expect(h.actor_type?.type === "choice" && h.actor_type.label).toBe("human");
    expect(b.actor_type?.type === "choice" && b.actor_type.label).toBe("credential_stuffer");
    expect(b.intent?.type === "choice" && b.intent.label).toBe("account_takeover");
  });

  it("recognises spam text and declared agents", async () => {
    const s = await mock.decide(spam, set, askedQuestionKeys(spam, set), { signal: signal() });
    expect(s.actor_type?.type === "choice" && s.actor_type.label).toBe("spam_bot");
    expect(s.content_is_templated?.type === "noul" && s.content_is_templated.p).toBeGreaterThan(0.6);
    const a = await mock.decide(agent, set, askedQuestionKeys(agent, set), { signal: signal() });
    expect(a.actor_type?.type === "choice" && a.actor_type.label).toBe("declared_agent");
    expect(a.risk_level?.type === "score" && a.risk_level.value).toBe(0);
  });
});

describe("RulesOnlyProvider", () => {
  it("never reports confidence above 0.6", async () => {
    const r = new RulesOnlyProvider();
    for (const s of [human, bot, spam, agent]) {
      const a = await r.decide(s, set, askedQuestionKeys(s, set));
      for (const ans of Object.values(a)) expect(ans.confidence).toBeLessThanOrEqual(RulesOnlyProvider.MAX_CONFIDENCE);
    }
  });
});

class HangingProvider implements DecisionProvider {
  readonly name = "jev" as const;
  aborted = false;
  decide(_s: unknown, _q: unknown, _k: unknown, { signal }: { signal: AbortSignal }): Promise<Answers> {
    return new Promise((_, reject) => {
      signal.addEventListener("abort", () => {
        this.aborted = true;
        reject(signal.reason);
      });
    });
  }
}

const provider = (fn: () => Promise<Answers>): DecisionProvider => ({ name: "jev", decide: fn });

describe("decideWithFallback", () => {
  const rules = new RulesOnlyProvider();

  it("uses the primary when it answers in time", async () => {
    const r = await decideWithFallback(new MockProvider(), rules, human, set, { timeoutMs: 400 });
    expect(r.source).toBe("mock");
    expect(r.fallback_reason).toBeUndefined();
  });

  it("falls back on timeout at the configured deadline and aborts the request", async () => {
    vi.useFakeTimers();
    try {
      const hanging = new HangingProvider();
      const p = decideWithFallback(hanging, rules, human, set, { timeoutMs: 400 });
      await vi.advanceTimersByTimeAsync(399);
      expect(hanging.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const r = await p;
      expect(r).toMatchObject({ source: "fallback", fallback_reason: "timeout" });
      expect(hanging.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back in real time well under the budget", async () => {
    const start = performance.now();
    const r = await decideWithFallback(new MockProvider({ delayMs: 5_000 }), rules, bot, set, { timeoutMs: 50 });
    expect(r.source).toBe("fallback");
    expect(performance.now() - start).toBeLessThan(200);
  });

  it("falls back on errors", async () => {
    const r = await decideWithFallback(provider(() => Promise.reject(new Error("boom"))), rules, human, set, { timeoutMs: 400 });
    expect(r).toMatchObject({ source: "fallback", fallback_reason: "error" });
  });

  it("falls back on malformed answers", async () => {
    const bad = provider(async () => ({ is_automated: { type: "noul", p: 2 } }) as unknown as Answers);
    const r = await decideWithFallback(bad, rules, human, set, { timeoutMs: 400 });
    expect(r).toMatchObject({ source: "fallback", fallback_reason: "invalid_response" });
  });

  it("falls back when an asked question is missing", async () => {
    const partial = provider(async () => {
      const a = await new MockProvider().decide(human, set, askedQuestionKeys(human, set), { signal: signal() });
      delete a.intent;
      return a;
    });
    const r = await decideWithFallback(partial, rules, human, set, { timeoutMs: 400 });
    expect(r.fallback_reason).toBe("invalid_response");
  });
});

describe("JevProvider", () => {
  const API_KEY = "tsk_live_do_not_log_me_0123456789";

  it("without the documented wire schema, fails fast and degrades to rules", async () => {
    const fetchSpy = vi.fn();
    const jev = new JevProvider({ apiKey: API_KEY, baseUrl: "https://api.example", fetch: fetchSpy });
    const r = await decideWithFallback(jev, new RulesOnlyProvider(), human, set, { timeoutMs: 400 });
    expect(r).toMatchObject({ source: "fallback", fallback_reason: "error" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // A stand-in wire adapter to exercise transport behaviour. NOT the real Jev schema.
  const testWire: JevWire = {
    path: "/test",
    buildBody: (state, _set, keys) => ({ state, keys }),
    parseResponse: (json) => json as Answers,
    authHeaders: (key) => ({ "x-test-key": key }),
  };

  it("sends the key only in the auth header, with an abort signal", async () => {
    const mockAnswers = await new MockProvider().decide(human, set, askedQuestionKeys(human, set), { signal: signal() });
    const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(mockAnswers), { status: 200 }));
    const jev = new JevProvider({ apiKey: API_KEY, baseUrl: "https://api.example/", wire: testWire, fetch: fetchSpy as unknown as typeof fetch });
    const r = await decideWithFallback(jev, new RulesOnlyProvider(), human, set, { timeoutMs: 400 });
    expect(r.source).toBe("jev");
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.example/test");
    expect((init.headers as Record<string, string>)["x-test-key"]).toBe(API_KEY);
    expect(String(init.body)).not.toContain(API_KEY);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("treats HTTP errors as fallback", async () => {
    const fetchSpy = vi.fn(async () => new Response("nope", { status: 503 }));
    const jev = new JevProvider({ apiKey: API_KEY, baseUrl: "https://api.example", wire: testWire, fetch: fetchSpy as unknown as typeof fetch });
    const r = await decideWithFallback(jev, new RulesOnlyProvider(), human, set, { timeoutMs: 400 });
    expect(r).toMatchObject({ source: "fallback", fallback_reason: "error" });
  });

  it("never exposes the API key through serialisation", () => {
    const jev = new JevProvider({ apiKey: API_KEY, baseUrl: "https://api.example" });
    expect(JSON.stringify(jev)).not.toContain(API_KEY);
    expect(JSON.stringify({ ...jev })).not.toContain(API_KEY);
    expect(() => new JevProvider({ apiKey: "", baseUrl: "https://x" })).toThrow();
  });
});

describe("decide (pipeline)", () => {
  const base = {
    checks: okChecks,
    capabilities: { passkey: true, email: true, id_verify: false },
    mode: "enforce" as const,
    questions: set,
    fallback: new RulesOnlyProvider(),
    timeoutMs: 400,
  };

  it("lets a real-looking human through with zero friction", async () => {
    const out = await decide({ ...base, state: human, policy: defaultPolicy("signup"), provider: new MockProvider() });
    expect(out.decision.effective_action).toBe("allow");
    expect(out.source).toBe("mock");
    expect(out.questions_version).toBe("v1");
  });

  it("blocks a headless swarm", async () => {
    const out = await decide({ ...base, state: bot, policy: defaultPolicy("login"), provider: new MockProvider() });
    expect(out.decision.effective_action).toBe("block");
  });

  it("shadow-drops obvious comment spam", async () => {
    const out = await decide({ ...base, state: spam, policy: defaultPolicy("comment"), provider: new MockProvider() });
    expect(out.decision.effective_action).toBe("shadow_drop");
  });

  it("skips the model entirely on hard blocks", async () => {
    const spy = vi.fn();
    const out = await decide({
      ...base,
      checks: { ...okChecks, rate_limited: ["ip"] },
      state: human,
      policy: defaultPolicy("signup"),
      provider: provider(spy),
    });
    expect(spy).not.toHaveBeenCalled();
    expect(out.source).toBe("none");
    expect(out.decision.action).toBe("block");
  });

  it("in fallback, humans still pass and bots are stepped up rather than blocked on heuristics alone", async () => {
    const failing = provider(() => Promise.reject(new Error("down")));
    const h = await decide({ ...base, state: human, policy: defaultPolicy("signup"), provider: failing });
    expect(h.source).toBe("fallback");
    expect(h.decision.effective_action).toBe("allow");
    expect(h.decision.reasons.some((r) => r.code === "degraded")).toBe(true);

    const b = await decide({ ...base, state: bot, policy: defaultPolicy("login"), provider: failing });
    expect(b.decision.effective_action).toMatch(/^step_up:/);
  });
});
