import { describe, expect, it } from "vitest";
import { signToken, solvePow, type Answers, type DecisionProvider } from "@proofline/core";
import { selectProvider, SIGNAL_TOKEN_TYPE } from "../src/index.js";
import { CHROME_HEADERS, ORIGIN, assess, botSignals, flush, getToken, harness, humanSignals } from "./helpers.js";

describe("health and errors", () => {
  it("serves health and uniform errors", async () => {
    const h = await harness();
    expect(await (await h.app.request("/v1/health")).json()).toEqual({ ok: true });
    const r = await h.app.request("/v1/nope");
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: { code: "not_found", message: "No such route" } });
  });
});

describe("POST /v1/signals", () => {
  it("returns a signed token for an allowed origin, with CORS headers and no raw IP", async () => {
    const h = await harness();
    const { res, body } = await getToken(h, humanSignals);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(body.expires_in).toBe(300);
    expect(body.token).toMatch(/^pl1\./);
    const claims = atob(body.token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"));
    expect(claims).not.toContain("203.0.113.50");
    expect(res.headers.get("server-timing")).toMatch(/edge;dur=/);
  });

  it("rejects other origins, secret keys, bad bodies and oversize bodies", async () => {
    const h = await harness();
    expect((await getToken(h, humanSignals, {}, { origin: "https://evil.test" })).res.status).toBe(403);
    expect((await getToken(h, humanSignals, { key: h.sk })).res.status).toBe(403);
    expect((await getToken(h, humanSignals, { key: "pl_pk_test_" + "x".repeat(30) })).res.status).toBe(401);
    const bad = await getToken(h, { ...humanSignals, page_ms: -1 });
    expect(bad.res.status).toBe(400);
    expect((bad.body as unknown as { error: { code: string } }).error.code).toBe("bad_request");
    const big = await h.app.request("/v1/signals", { method: "POST", headers: { origin: ORIGIN }, body: "x".repeat(20_000) });
    expect(big.status).toBe(413);
  });

  it("answers CORS preflight", async () => {
    const h = await harness();
    const r = await h.app.request("/v1/signals", { method: "OPTIONS", headers: { origin: ORIGIN } });
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-methods")).toBe("POST");
  });

  it("drops per-field detail when consent is off", async () => {
    const h = await harness();
    const { body } = await getToken(h, { ...humanSignals, consent: false });
    const claims = JSON.parse(atob(body.token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")));
    expect(claims.data.b.fields).toBeUndefined();
  });
});

describe("POST /v1/assess", () => {
  it("allows a human and logs the decision with stage timings", async () => {
    const h = await harness({ mode: "enforce" });
    const { body: t } = await getToken(h, humanSignals);
    const { res, body } = await assess(h, {
      signal_token: t.token,
      context: { account: { age_days: 300, email_domain: "gmail.com" } },
    });
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ action: "allow", mode: "enforce", risk: 0 });
    expect(res.headers.get("server-timing")).toMatch(/verify;dur=.*decide;dur=.*total;dur=/);
    await flush();
    const logged = await h.store.getDecision(h.project.id, body.decision_id as string);
    expect(logged).toMatchObject({ action: "allow", token_status: "valid", decision_source: "mock", actor_type: "human", ua_family: "chrome" });
    expect(logged!.t_total_ms).toBeGreaterThan(0);
    expect(logged!.t_decide_ms).not.toBeNull();
    expect(JSON.stringify(logged)).not.toContain("gmail.com");
  });

  it("in shadow mode always allows, reporting what it would have done", async () => {
    const h = await harness({ mode: "shadow" });
    const { body: t } = await getToken(h, botSignals, {}, { "user-agent": "HeadlessChrome/140" });
    const { body } = await assess(h, { signal_token: t.token });
    expect(body.action).toBe("allow");
    expect(body.would_have).not.toBe("allow");
    expect((body.reasons as unknown[]).length).toBeGreaterThan(0);
  });

  it("in enforce mode stops a headless bot", async () => {
    const h = await harness({ mode: "enforce" });
    const { body: t } = await getToken(h, botSignals, {}, { "user-agent": "HeadlessChrome/140" });
    const { body } = await assess(h, { signal_token: t.token });
    expect(body.action).not.toBe("allow");
  });

  it("hard-blocks replayed, forged and cross-project tokens", async () => {
    const h = await harness({ mode: "enforce" });
    const { body: t } = await getToken(h, humanSignals);
    expect((await assess(h, { signal_token: t.token })).body.action).toBe("allow");
    const replay = await assess(h, { signal_token: t.token });
    expect(replay.body.action).toBe("block");
    await flush();
    expect((await h.store.getDecision(h.project.id, replay.body.decision_id as string))?.matched).toMatch(/^hard:/);

    const forged = await signToken("another-secret-another-secret-another-1", SIGNAL_TOKEN_TYPE, {}, { ttlSeconds: 60 });
    expect((await assess(h, { signal_token: forged })).body.action).toBe("block");

    const other = await harness({ mode: "enforce" });
    const { body: t2 } = await getToken(other, humanSignals);
    // Same signing secret, different project: still invalid here.
    expect((await assess(h, { signal_token: t2.token })).body.action).toBe("block");

    const { body: t3 } = await getToken(h, humanSignals);
    expect((await assess(h, { signal_token: t3.token, event_type: "checkout" })).body.action).toBe("block");
  });

  it("treats a missing token as a signal, not an error, and uses forwarded client details", async () => {
    const h = await harness({ mode: "enforce" });
    const { res, body } = await assess(h, { client: { ip: "198.51.100.7", user_agent: "curl/8.5.0" } });
    expect(res.status).toBe(200);
    expect(body.action).not.toBe("allow");
    await flush();
    const logged = await h.store.getDecision(h.project.id, body.decision_id as string);
    expect(logged).toMatchObject({ token_status: "missing", ua_family: "curl" });
    expect(JSON.stringify(logged)).not.toContain("198.51.100.7");
  });

  it("requires a secret key", async () => {
    const h = await harness();
    expect((await assess(h, {}, h.pk)).res.status).toBe(403);
    expect((await assess(h, {}, "nope")).res.status).toBe(401);
  });

  it("rate limits per API key", async () => {
    const h = await harness({ deps: { keyRateLimit: { publishable: 100, secret: 3 } } });
    for (let i = 0; i < 3; i++) expect((await assess(h, {})).res.status).toBe(200);
    const limited = await assess(h, {});
    expect(limited.res.status).toBe(429);
    expect(limited.res.headers.get("retry-after")).toBe("60");
  });

  it("falls back to rules within the time budget when the provider hangs", async () => {
    const hanging: DecisionProvider = {
      name: "jev",
      decide: (_s, _q, _k, { signal }) => new Promise<Answers>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
    };
    const h = await harness({ mode: "enforce", provider: hanging });
    const { body: t } = await getToken(h, humanSignals);
    const start = performance.now();
    const { body } = await assess(h, { signal_token: t.token });
    expect(performance.now() - start).toBeLessThan(450);
    expect(body.degraded).toBe(true);
    await flush();
    expect(await h.store.getDecision(h.project.id, body.decision_id as string)).toMatchObject({ decision_source: "fallback", fallback_reason: "timeout" });
  });

  it("calls Jev with the documented request when configured", async () => {
    const calls: string[] = [];
    const fetchStub = (async (url: string, init: RequestInit) => {
      calls.push(url);
      const body = JSON.parse(String(init.body)) as { questions: Record<string, { type: string; criteria: unknown }> };
      const answers: Record<string, unknown> = {};
      for (const [k, q] of Object.entries(body.questions)) {
        if (q.type === "noul") answers[k] = { type: "noul", noul: 0.03 };
        if (q.type === "choice") {
          const opts = Object.keys(q.criteria as object);
          answers[k] = { type: "choice", choice: opts[0], probabilities: Object.fromEntries(opts.map((o, i) => [o, i === 0 ? 1 : 0])), confidence: 1 };
        }
        if (q.type === "score") {
          const n = (q.criteria as unknown[]).length;
          answers[k] = { type: "score", score: 0, legend: {}, probabilities: Object.fromEntries([...Array(n)].map((_, i) => [String(i), i === 0 ? 1 : 0])), confidence: 1 };
        }
      }
      return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 1, output_tokens: 1 } }));
    }) as unknown as typeof fetch;
    const h = await harness({ provider: selectProvider({ TYPESAFE_API_KEY: "tsk_test", JEV_MODEL: "jev-1.13.0" }, fetchStub) });
    const { body: t } = await getToken(h, humanSignals);
    const { body } = await assess(h, { signal_token: t.token });
    expect(calls).toEqual(["https://api.typesafe.ai/v1/systemone"]);
    await flush();
    expect(await h.store.getDecision(h.project.id, body.decision_id as string)).toMatchObject({ decision_source: "jev", actor_type: "human" });
  });
});

describe("proof of work", () => {
  it("issues a challenge, accepts one solution, and flags reuse", async () => {
    const h = await harness({ mode: "enforce", pow_bits: 8 });
    const ch = (await (
      await h.app.request("/v1/pow", { method: "POST", headers: { origin: ORIGIN }, body: JSON.stringify({ key: h.pk }) })
    ).json()) as { enabled: boolean; token: string; salt: string; bits: number };
    expect(ch).toMatchObject({ enabled: true, bits: 8 });
    const nonce = await solvePow(ch.salt, ch.bits);

    const first = await getToken(h, humanSignals, { pow: { token: ch.token, nonce } });
    const claims = JSON.parse(atob(first.body.token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")));
    expect(claims.data.pw).toBe("passed");

    const again = await getToken(h, humanSignals, { pow: { token: ch.token, nonce } });
    const { body } = await assess(h, { signal_token: again.body.token });
    expect(body.action).toBe("block");
  });

  it("reports disabled when the project has no PoW", async () => {
    const h = await harness();
    const r = await h.app.request("/v1/pow", { method: "POST", headers: { origin: ORIGIN, ...CHROME_HEADERS }, body: JSON.stringify({ key: h.pk }) });
    expect(await r.json()).toEqual({ enabled: false });
  });
});

describe("POST /v1/feedback", () => {
  it("records labels for known decisions only", async () => {
    const h = await harness();
    const { body: d } = await assess(h, {});
    await flush();
    const post = (body: unknown, key = h.sk) =>
      h.app.request("/v1/feedback", { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
    expect((await post({ decision_id: d.decision_id, label: "false_positive", note: "real customer" })).status).toBe(201);
    expect(h.store.feedback).toHaveLength(1);
    expect((await post({ decision_id: "01890000-0000-7000-8000-000000000000", label: "confirmed_bot" })).status).toBe(404);
    expect((await post({ decision_id: d.decision_id, label: "maybe" })).status).toBe(400);
    expect((await post({ decision_id: d.decision_id, label: "confirmed_bot" }, h.pk)).status).toBe(403);
  });
});
