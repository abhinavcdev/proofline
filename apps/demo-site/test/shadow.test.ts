import { describe, expect, it } from "vitest";
import { MemoryReplayGuard, MockProvider, signToken, type BrowserSignals } from "@proofline/core";
import { createApp, SIGNAL_TOKEN_TYPE } from "@proofline/api";
import { MemoryStore } from "@proofline/db";
import { MemoryRateCounter, StaticIpList, genericContext } from "@proofline/edge";
import { createProofline } from "@proofline/sdk-server";
import { createDemoApp } from "../src/app.js";

/**
 * The shadow-mode guarantee, end to end: a corpus of bot submissions through
 * the real API and the real demo handlers. In shadow mode every one succeeds;
 * in enforce mode the same corpus is stopped. That shows the API detected
 * them and shadow mode is what let them through.
 */

const ORIGIN = "http://localhost:3000";
const SECRET = "token-secret-token-secret-token-secret-01";
const CHROME = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const BROWSER_HEADERS = { "user-agent": CHROME, "accept-language": "en-US", "sec-fetch-mode": "cors", "sec-ch-ua": '"Chromium";v="140"' };

const human: BrowserSignals = {
  v: 1,
  consent: true,
  page_ms: 35_000,
  fields: [
    { kind: "text", dwell_ms: 3_000, keys: 9, corrections: 1, pastes: 0, focus: 1 },
    { kind: "email", dwell_ms: 4_000, keys: 20, corrections: 0, pastes: 0, focus: 1 },
    { kind: "password", dwell_ms: 3_000, keys: 12, corrections: 1, pastes: 0, focus: 1 },
  ],
  keys: { count: 41, iki_mean_ms: 175, iki_var_ms2: 6_500, corrections: 2 },
  pastes: 0,
  pointer: { type: "mouse", events: 300, entropy: 0.8 },
  focus_blur: 7,
  automation: { webdriver: false, headless_hints: [], viewport_consistent: true },
};
const headless: BrowserSignals = {
  ...human,
  page_ms: 600,
  fields: human.fields!.map((f) => ({ ...f, dwell_ms: 15, corrections: 0 })),
  keys: { count: 41, iki_mean_ms: 4, iki_var_ms2: 0, corrections: 0 },
  pointer: { type: "none", events: 0, entropy: 0 },
  focus_blur: 3,
  automation: { webdriver: true, headless_hints: ["no_plugins", "headless_ua"], viewport_consistent: false },
};

async function stack(mode: "shadow" | "enforce") {
  const store = new MemoryStore();
  const project = await store.createProject({ name: "Crumb", allowed_origins: [ORIGIN], mode });
  const other = await store.createProject({ name: "Other", allowed_origins: [ORIGIN], mode });
  const sk = (await store.createApiKey(project.id, "secret")).key;
  const pk = (await store.createApiKey(project.id, "publishable")).key;
  const otherPk = (await store.createApiKey(other.id, "publishable")).key;
  const api = createApp({
    store,
    rate: new MemoryRateCounter(),
    replay: new MemoryReplayGuard(),
    tokenSecrets: [SECRET],
    ipSaltSecret: "salt-secret-salt-secret-salt-secret-0001",
    provider: new MockProvider(),
    ipReputation: new StaticIpList(["198.51.100.0/24"]),
    edgeContext: (c) => genericContext(c.req.raw, { ip: c.req.header("x-forwarded-for"), direct: true }),
  });
  const apiFetch = ((url: string, init: RequestInit) => api.request(url, init)) as unknown as typeof fetch;
  const demo = createDemoApp({
    proofline: createProofline({ secretKey: sk, baseUrl: "http://api.test", fetch: apiFetch }),
    publishableKey: pk,
    apiUrl: "http://api.test",
    sdkScript: async () => "",
    trustProxy: true,
  });

  const signalToken = async (signals: BrowserSignals, ip: string, opts: { key?: string; event?: string; ua?: string } = {}) => {
    const r = await api.request("/v1/signals", {
      method: "POST",
      headers: { "content-type": "text/plain", origin: ORIGIN, "x-forwarded-for": ip, ...BROWSER_HEADERS, ...(opts.ua ? { "user-agent": opts.ua } : {}) },
      body: JSON.stringify({ key: opts.key ?? pk, event_type: opts.event ?? "signup", signals }),
    });
    return ((await r.json()) as { token: string }).token;
  };

  const submit = (path: string, fields: Record<string, string>, ip: string, ua = CHROME) =>
    demo.app.request(path, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip, "user-agent": ua },
      body: new URLSearchParams(fields).toString(),
    });

  return { store, project, demo, signalToken, submit, otherPk };
}

type Stack = Awaited<ReturnType<typeof stack>>;
const signupFields = { name: "Ada", email: "ada@gmail.com", password: "correct horse battery" };

/** Each profile performs one or more submissions and returns their responses. */
const corpus: Record<string, (s: Stack) => Promise<Response[]>> = {
  "naive-curl (no token)": async (s) => [await s.submit("/signup", signupFields, "203.0.113.10", "curl/8.5.0")],
  "forged token": async (s) => {
    const forged = await signToken("attacker-secret-attacker-secret-attack", SIGNAL_TOKEN_TYPE, {}, { ttlSeconds: 300 });
    return [await s.submit("/signup", { ...signupFields, proofline_token: forged }, "203.0.113.11")];
  },
  "replayed token": async (s) => {
    const t = await s.signalToken(human, "203.0.113.12");
    await s.submit("/signup", { ...signupFields, proofline_token: t }, "203.0.113.12");
    return [await s.submit("/signup", { ...signupFields, proofline_token: t }, "203.0.113.13")];
  },
  "token from another project": async (s) => {
    const t = await s.signalToken(human, "203.0.113.14", { key: s.otherPk });
    return [await s.submit("/signup", { ...signupFields, proofline_token: t }, "203.0.113.14")];
  },
  "expired token": async (s) => {
    const t = await signToken(SECRET, SIGNAL_TOKEN_TYPE, {}, { ttlSeconds: 300, now: Date.now() - 3_600_000 });
    return [await s.submit("/signup", { ...signupFields, proofline_token: t }, "203.0.113.15", "python-requests/2.32")];
  },
  "headless browser": async (s) => {
    const t = await s.signalToken(headless, "203.0.113.16", { ua: CHROME.replace("Chrome/", "HeadlessChrome/") });
    return [await s.submit("/signup", { ...signupFields, proofline_token: t }, "203.0.113.16")];
  },
  "known-bad IP": async (s) => {
    const t = await s.signalToken(human, "198.51.100.23");
    return [await s.submit("/signup", { ...signupFields, proofline_token: t }, "198.51.100.23")];
  },
  "spam comment": async (s) => [
    await s.submit(
      "/contact",
      { email: "seo@mailinator.com", message: "Dear webmaster!!! Boost your ranking with cheap backlinks https://a.example https://b.example https://c.example" },
      "203.0.113.17",
      "Mozilla/5.0 (compatible; SpamBot/1.0)",
    ),
  ],
  "swarm (130 requests, one IP)": async (s) => {
    const out: Response[] = [];
    for (let i = 0; i < 130; i++) {
      const t = await s.signalToken(headless, "203.0.113.99", { ua: CHROME.replace("Chrome/", "HeadlessChrome/") });
      out.push(await s.submit("/signup", { ...signupFields, email: `bot${i}@example.com`, proofline_token: t }, "203.0.113.99"));
    }
    return out;
  },
};

describe("shadow mode never blocks", () => {
  it.each(Object.keys(corpus))("%s: every submission succeeds, and the decision log shows what would have happened", async (name) => {
    const s = await stack("shadow");
    const before = s.demo.submissions.length;
    const responses = await corpus[name]!(s);
    for (const r of responses) {
      expect(r.status).toBe(200);
      expect(await r.text()).toMatch(/Welcome to the bread club|Thanks for your message/);
    }
    // Every submission was accepted by the demo site (the replay profile makes one extra, human submission).
    expect(s.demo.submissions.length - before).toBeGreaterThanOrEqual(responses.length);
    expect(s.demo.submissions.every((x) => x.decision.action === "allow")).toBe(true);

    await new Promise((r) => setTimeout(r, 0));
    const logged = await s.store.listDecisions(s.project.id, { limit: 500 });
    const last = logged[0]!;
    expect(last.mode).toBe("shadow");
    expect(last.effective_action).toBe("allow");
    expect(last.action).not.toBe("allow");
  });

  it("randomised signals and payloads never produce anything but allow", async () => {
    const s = await stack("shadow");
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 60; i++) {
      const signals: BrowserSignals = {
        ...human,
        page_ms: Math.floor(rnd() * 120_000),
        keys: { count: Math.floor(rnd() * 200), iki_mean_ms: rnd() * 400, iki_var_ms2: rnd() * 50_000, corrections: Math.floor(rnd() * 5) },
        pastes: Math.floor(rnd() * 4),
        pointer: { type: rnd() > 0.5 ? "mouse" : "none", events: Math.floor(rnd() * 500), entropy: rnd() },
        automation: { webdriver: rnd() > 0.7, headless_hints: rnd() > 0.5 ? ["no_plugins"] : [], viewport_consistent: rnd() > 0.3 },
      };
      const ip = `203.0.113.${Math.floor(rnd() * 250)}`;
      const t = rnd() > 0.2 ? await s.signalToken(signals, ip) : "garbage";
      const r = await s.submit("/signup", { ...signupFields, proofline_token: t }, ip, rnd() > 0.5 ? CHROME : "curl/8");
      expect(r.status).toBe(200);
    }
    expect(s.demo.submissions.every((x) => x.decision.action === "allow")).toBe(true);
  });
});

describe("the same corpus in enforce mode", () => {
  it.each(Object.keys(corpus))("%s: is stopped (blocked, stepped up, or silently dropped)", async (name) => {
    const s = await stack("enforce");
    const responses = await corpus[name]!(s);
    const last = responses.at(-1)!;
    await new Promise((r) => setTimeout(r, 0));
    const [decision] = await s.store.listDecisions(s.project.id, { limit: 1 });
    expect(decision!.effective_action).not.toBe("allow");
    if (decision!.effective_action === "shadow_drop") {
      // Looks like success to the sender, but the site doesn't act on it.
      expect(last.status).toBe(200);
      expect(s.demo.submissions.some((x) => x.decision.decision_id === decision!.id)).toBe(false);
    } else if (decision!.effective_action.startsWith("step_up:")) {
      expect(last.status).toBe(303);
      expect(last.headers.get("location")).toMatch(/^\/verify\?c=ch_/);
    } else {
      expect(last.status).toBe(403);
    }
  });

  it("lets a human through", async () => {
    const s = await stack("enforce");
    const t = await s.signalToken(human, "203.0.113.200");
    const r = await s.submit("/signup", { ...signupFields, proofline_token: t }, "203.0.113.200");
    expect(r.status).toBe(200);
  });
});
