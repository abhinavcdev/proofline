import { describe, expect, it, vi } from "vitest";
import { MemoryReplayGuard, MockProvider } from "@proofline/core";
import { createApp } from "@proofline/api";
import { MemoryStore } from "@proofline/db";
import { MemoryRateCounter } from "@proofline/edge";
import { TOKEN_FIELD, clientFromHeaders, createProofline, tokenFromForm, type ProoflineError } from "../src/index.js";

async function realApi(mode: "shadow" | "enforce" = "enforce") {
  const store = new MemoryStore();
  const project = await store.createProject({ name: "t", mode });
  const sk = (await store.createApiKey(project.id, "secret")).key;
  const app = createApp({
    store,
    rate: new MemoryRateCounter(),
    replay: new MemoryReplayGuard(),
    tokenSecrets: ["token-secret-token-secret-token-secret-01"],
    ipSaltSecret: "salt-secret-salt-secret-salt-secret-0001",
    provider: new MockProvider(),
  });
  const fetchImpl = ((url: string, init: RequestInit) => app.request(url, init)) as unknown as typeof fetch;
  return { sk, fetchImpl, store };
}

describe("createProofline", () => {
  it("refuses publishable keys", () => {
    expect(() => createProofline({ secretKey: "pl_pk_test_abc" })).toThrow(/secret key/);
  });

  it("assesses against the real API and sends feedback", async () => {
    const { sk, fetchImpl, store } = await realApi();
    const pl = createProofline({ secretKey: sk, baseUrl: "http://api.test", fetch: fetchImpl });
    const r = await pl.assess({ eventType: "signup", client: { ip: "198.51.100.1", user_agent: "curl/8" } });
    expect(r.decision_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.action).not.toBe("allow");
    expect(r.degraded).toBeUndefined();
    await new Promise((res) => setTimeout(res, 0));
    await pl.feedback({ decisionId: r.decision_id!, label: "confirmed_bot" });
    expect(store.feedback).toHaveLength(1);
  });

  it("fails open on timeout, network errors, HTTP errors and junk, reporting each", async () => {
    const errors: ProoflineError[] = [];
    const cases: Array<[typeof fetch, string]> = [
      [((_u: string, init: RequestInit) => new Promise((_, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch, "timeout"],
      [(async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch, "network"],
      [(async () => new Response("{}", { status: 401 })) as unknown as typeof fetch, "http"],
      [(async () => new Response("not json")) as unknown as typeof fetch, "invalid_response"],
      [(async () => new Response(JSON.stringify({ nope: 1 }))) as unknown as typeof fetch, "invalid_response"],
    ];
    for (const [f, kind] of cases) {
      const pl = createProofline({ secretKey: "pl_sk_test_x", fetch: f, timeoutMs: 50, onError: (e) => errors.push(e) });
      const start = Date.now();
      expect(await pl.assess({ eventType: "login" })).toEqual({ action: "allow", degraded: true, error: kind });
      expect(Date.now() - start).toBeLessThan(500);
    }
    expect(errors.map((e) => e.kind)).toEqual(["timeout", "network", "http", "invalid_response", "invalid_response"]);
  });

  it("survives a throwing onError hook", async () => {
    const pl = createProofline({
      secretKey: "pl_sk_test_x",
      fetch: vi.fn(async () => new Response("", { status: 500 })) as unknown as typeof fetch,
      onError: () => {
        throw new Error("logger broke");
      },
    });
    expect((await pl.assess({ eventType: "login" })).action).toBe("allow");
  });
});

describe("helpers", () => {
  it("reads client details, trusting forwarding headers only when asked", () => {
    const h = { "x-forwarded-for": "203.0.113.1, 10.0.0.1", "user-agent": "UA", "accept-language": "en" };
    expect(clientFromHeaders(h, { remoteAddress: "10.0.0.1" })).toEqual({ ip: "10.0.0.1", user_agent: "UA", accept_language: "en" });
    expect(clientFromHeaders(h, { remoteAddress: "10.0.0.1", trustProxy: true }).ip).toBe("203.0.113.1");
    expect(clientFromHeaders(new Headers({ "cf-connecting-ip": "198.51.100.9" }), { trustProxy: true }).ip).toBe("198.51.100.9");
  });

  it("reads the token from form data", () => {
    const fd = new FormData();
    fd.set(TOKEN_FIELD, "pl1.a.b");
    expect(tokenFromForm(fd)).toBe("pl1.a.b");
    expect(tokenFromForm({ [TOKEN_FIELD]: "" })).toBeUndefined();
    expect(tokenFromForm({})).toBeUndefined();
  });
});
