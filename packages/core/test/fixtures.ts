import type { BrowserSignals, DeterministicChecks, EdgeSignals, ServerContext } from "../src/index.js";

export const humanBrowser: BrowserSignals = {
  v: 1,
  consent: true,
  page_ms: 38_000,
  fields: [
    { kind: "text", dwell_ms: 4_200, keys: 14, corrections: 1, pastes: 0, focus: 1 },
    { kind: "email", dwell_ms: 5_100, keys: 22, corrections: 0, pastes: 0, focus: 1 },
    { kind: "password", dwell_ms: 3_000, keys: 12, corrections: 1, pastes: 0, focus: 2 },
  ],
  keys: { count: 48, iki_mean_ms: 170, iki_var_ms2: 6_400, corrections: 2 },
  pastes: 0,
  pointer: { type: "mouse", events: 412, entropy: 0.78 },
  focus_blur: 8,
  automation: { webdriver: false, headless_hints: [], viewport_consistent: true },
};

export const headlessBrowser: BrowserSignals = {
  v: 1,
  consent: true,
  page_ms: 900,
  fields: [
    { kind: "text", dwell_ms: 40, keys: 14, corrections: 0, pastes: 0, focus: 1 },
    { kind: "email", dwell_ms: 60, keys: 22, corrections: 0, pastes: 0, focus: 1 },
  ],
  keys: { count: 36, iki_mean_ms: 10, iki_var_ms2: 0.01, corrections: 0 },
  pastes: 0,
  pointer: { type: "none", events: 0, entropy: 0 },
  focus_blur: 2,
  automation: { webdriver: true, headless_hints: ["no_plugins", "swiftshader_webgl"], viewport_consistent: false },
};

export const humanEdge: EdgeSignals = {
  ip_hash: "0123456789abcdef0123456789abcdef",
  asn: 7922,
  asn_class: "residential",
  country: "US",
  header_fp: "a1b2c3",
  header_anomalies: [],
  ua_family: "chrome",
  rate: { ip_1m: 1, asn_1m: 12, fp_1m: 1 },
  declared_agent: { status: "none" },
  known_bad_ip: false,
};

export const swarmEdge: EdgeSignals = {
  ...humanEdge,
  asn: 16509,
  asn_class: "datacenter",
  header_anomalies: ["missing_accept_language", "ua_client_hints_mismatch"],
  rate: { ip_1m: 45, asn_1m: 800, fp_1m: 120 },
};

export const agentEdge: EdgeSignals = {
  ...humanEdge,
  asn_class: "datacenter",
  declared_agent: { status: "verified", name: "example-shopping-agent" },
};

export const humanServer: ServerContext = {
  account: { age_days: 400, email_domain: "gmail.com", has_passkey: true, has_verified_email: true },
  history: { events_30d: 6, blocked_30d: 0, stepped_up_30d: 0 },
};

export const okChecks: DeterministicChecks = {
  token: "valid",
  pow: "absent",
  rate_limited: [],
  known_bad_ip: false,
  declared_agent: "none",
};

export const SECRET = "test-secret-test-secret-test-secret-0001";
