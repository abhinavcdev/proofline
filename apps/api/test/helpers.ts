import { MemoryReplayGuard, MockProvider, type BrowserSignals, type DecisionProvider } from "@proofline/core";
import { MemoryStore, type Project } from "@proofline/db";
import { MemoryRateCounter, genericContext } from "@proofline/edge";
import { createApp, type ApiDeps } from "../src/index.js";

export const ORIGIN = "https://shop.test";
export const TOKEN_SECRET = "token-secret-token-secret-token-secret-01";
export const SALT = "salt-secret-salt-secret-salt-secret-0001";

export const CHROME_HEADERS = {
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  "accept-language": "en-GB,en;q=0.9",
  "sec-ch-ua": '"Chromium";v="140", "Google Chrome";v="140"',
  "sec-ch-ua-platform": '"macOS"',
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "cross-site",
};

export const humanSignals: BrowserSignals = {
  v: 1,
  consent: true,
  page_ms: 41_000,
  fields: [
    { kind: "email", dwell_ms: 5_000, keys: 22, corrections: 1, pastes: 0, focus: 1 },
    { kind: "password", dwell_ms: 3_500, keys: 12, corrections: 0, pastes: 0, focus: 1 },
  ],
  keys: { count: 34, iki_mean_ms: 180, iki_var_ms2: 7_000, corrections: 1 },
  pastes: 0,
  pointer: { type: "mouse", events: 380, entropy: 0.8 },
  focus_blur: 6,
  automation: { webdriver: false, headless_hints: [], viewport_consistent: true },
};

export const botSignals: BrowserSignals = {
  v: 1,
  consent: true,
  page_ms: 700,
  fields: [{ kind: "email", dwell_ms: 20, keys: 22, corrections: 0, pastes: 0, focus: 1 }],
  keys: { count: 34, iki_mean_ms: 5, iki_var_ms2: 0, corrections: 0 },
  pastes: 0,
  pointer: { type: "none", events: 0, entropy: 0 },
  focus_blur: 1,
  automation: { webdriver: true, headless_hints: ["no_plugins", "swiftshader_webgl"], viewport_consistent: false },
};

export interface Harness {
  app: ReturnType<typeof createApp>;
  store: MemoryStore;
  project: Project;
  pk: string;
  sk: string;
  deps: ApiDeps;
}

export async function harness(
  opts: { mode?: "shadow" | "enforce"; provider?: DecisionProvider; pow_bits?: number; deps?: Partial<ApiDeps>; ip?: string } = {},
): Promise<Harness> {
  const store = new MemoryStore();
  const project = await store.createProject({
    name: "Crumb & Co.",
    allowed_origins: [ORIGIN],
    mode: opts.mode ?? "shadow",
    ...(opts.pow_bits ? { pow_bits: opts.pow_bits } : {}),
  });
  const pk = (await store.createApiKey(project.id, "publishable")).key;
  const sk = (await store.createApiKey(project.id, "secret")).key;
  const deps: ApiDeps = {
    store,
    rate: new MemoryRateCounter(),
    replay: new MemoryReplayGuard(),
    tokenSecrets: [TOKEN_SECRET],
    ipSaltSecret: SALT,
    provider: opts.provider ?? new MockProvider(),
    edgeContext: (c) => genericContext(c.req.raw, { ip: c.req.header("x-test-ip") ?? opts.ip ?? "203.0.113.50", direct: true }),
    ...opts.deps,
  };
  return { app: createApp(deps), store, project, pk, sk, deps };
}

export async function getToken(h: Harness, signals: BrowserSignals, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const res = await h.app.request("/v1/signals", {
    method: "POST",
    headers: { "content-type": "text/plain;charset=UTF-8", origin: ORIGIN, ...CHROME_HEADERS, ...headers },
    body: JSON.stringify({ key: h.pk, event_type: "signup", signals, ...extra }),
  });
  return { res, body: (await res.json()) as { token: string; expires_in: number } };
}

export async function assess(h: Harness, body: Record<string, unknown>, key = h.sk) {
  const res = await h.app.request("/v1/assess", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ event_type: "signup", ...body }),
  });
  return { res, body: (await res.json()) as Record<string, unknown> };
}

/** Let background logging settle. */
export const flush = () => new Promise((r) => setTimeout(r, 0));
