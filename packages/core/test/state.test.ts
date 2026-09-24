import { describe, expect, it } from "vitest";
import {
  STATE_TOKEN_BUDGET,
  State,
  buckets,
  buildState,
  classifyEmailDomain,
  estimateTokens,
  redactText,
  type BrowserSignals,
} from "../src/index.js";
import { agentEdge, headlessBrowser, humanBrowser, humanEdge, humanServer, swarmEdge } from "./fixtures.js";

describe("buckets", () => {
  it.each([
    [0, "<2s"],
    [1_999, "<2s"],
    [2_000, "2-5s"],
    [29_999, "5-30s"],
    [60_000, "30s-5m"],
    [400_000, ">5m"],
  ])("timeBucket(%i) = %s", (ms, b) => expect(buckets.timeBucket(ms)).toBe(b));

  it.each([
    [0, "0"],
    [1, "1-10"],
    [10, "1-10"],
    [11, "11-50"],
    [200, "51-200"],
    [201, ">200"],
  ])("countBucket(%i) = %s", (n, b) => expect(buckets.countBucket(n)).toBe(b));

  it("classifies typing cadence and variability", () => {
    expect(buckets.cadenceBucket(10)).toBe("robotic");
    expect(buckets.cadenceBucket(170)).toBe("normal");
    expect(buckets.variabilityBucket(100, 0)).toBe("none");
    expect(buckets.variabilityBucket(170, 400)).toBe("low");
    expect(buckets.variabilityBucket(170, 6_400)).toBe("normal");
    expect(buckets.variabilityBucket(170, 40_000)).toBe("normal");
  });

  it("classifies pointer movement", () => {
    expect(buckets.pointerBucket("mouse", 0, 0)).toBe("none");
    expect(buckets.pointerBucket("mouse", 100, 0.1)).toBe("linear");
    expect(buckets.pointerBucket("mouse", 100, 0.8)).toBe("natural");
    expect(buckets.pointerBucket("touch", 3, 0)).toBe("touch");
  });

  it("classifies rates against thresholds", () => {
    const t = buckets.RATE_THRESHOLDS.ip;
    expect(buckets.rateBucket(1, t)).toBe("normal");
    expect(buckets.rateBucket(t.elevated, t)).toBe("elevated");
    expect(buckets.rateBucket(t.burst, t)).toBe("burst");
  });
});

describe("classifyEmailDomain", () => {
  it.each([
    ["gmail.com", "free"],
    ["user@Mailinator.com", "disposable"],
    ["stanford.edu", "edu"],
    ["ox.ac.uk", "edu"],
    ["acme-bakery.co", "corporate"],
    ["not a domain", "unknown"],
    [undefined, "unknown"],
  ])("%s → %s", (d, t) => expect(classifyEmailDomain(d)).toBe(t));
});

describe("redactText", () => {
  it("replaces emails, urls and phone numbers and counts them", () => {
    const r = redactText("Hi! Mail me at jane.doe@example.com or call +1 (415) 555-0199. See https://spam.example/x and cheap-pills.xyz");
    expect(r.excerpt).not.toMatch(/jane|example\.com|415|spam\.example|cheap-pills/);
    expect(r.excerpt).toContain("<email>");
    expect(r.excerpt).toContain("<phone>");
    expect(r.excerpt).toContain("<url>");
    expect(r.emails).toBe(1);
    expect(r.phones).toBe(1);
    expect(r.links).toBe(2);
  });

  it("redacts card-like numbers", () => {
    expect(redactText("my card is 4242 4242 4242 4242 thanks").excerpt).toBe("my card is <number> thanks");
  });

  it("truncates to the excerpt limit and collapses whitespace", () => {
    const r = redactText(`${"word   ".repeat(200)}`);
    expect(Array.from(r.excerpt).length).toBeLessThanOrEqual(280);
    expect(r.excerpt.endsWith("…")).toBe(true);
    expect(r.excerpt).not.toMatch(/\s{2,}/);
    expect(r.length).toBe("long");
  });
});

describe("buildState", () => {
  it("summarises a human session", () => {
    const s = buildState({ event: "signup", token: "valid", browser: humanBrowser, edge: humanEdge, server: humanServer });
    expect(s).toMatchObject({
      v: 1,
      event: "signup",
      sdk: "valid",
      behavior: {
        time_to_submit: "30s-5m",
        fields: 3,
        typing: { keys: "11-50", cadence: "normal", corrections: "1-2" },
        pastes: "0",
        pasted_fields: "none",
        pointer: "natural",
      },
      network: { asn_class: "residential", rate_ip: "normal" },
      account: { age: ">1y", email: "free" },
    });
    expect(s.automation).toBeUndefined();
    expect(State.safeParse(s).success).toBe(true);
  });

  it("surfaces automation and network signals for a headless swarm", () => {
    const s = buildState({ event: "login", token: "valid", browser: headlessBrowser, edge: swarmEdge });
    expect(s.automation).toEqual({
      webdriver: true,
      headless_hints: ["no_plugins", "swiftshader_webgl"],
      viewport_mismatch: true,
    });
    expect(s.behavior?.typing).toMatchObject({ cadence: "robotic", variability: "none" });
    expect(s.network).toMatchObject({ asn_class: "datacenter", rate_ip: "burst", rate_asn: "burst", rate_fingerprint: "burst" });
    expect(s.network?.header_anomalies).toEqual(["missing_accept_language", "ua_client_hints_mismatch"]);
  });

  it("records a missing SDK token without browser signals", () => {
    const s = buildState({ event: "comment", token: "missing", edge: humanEdge });
    expect(s.sdk).toBe("missing");
    expect(s.behavior).toBeUndefined();
  });

  it("marks verified and unverified declared agents", () => {
    expect(buildState({ event: "checkout", token: "missing", edge: agentEdge }).network?.declared_agent).toBe(
      "verified:example-shopping-agent",
    );
    const claim = { ...humanEdge, declared_agent: { status: "unverified_claim" as const, name: "GPTBot" } };
    expect(buildState({ event: "checkout", token: "missing", edge: claim }).network?.declared_agent).toBe("unverified_claim");
  });

  it("includes text only for text events, redacted", () => {
    const text = "Great SEO backlinks at https://x.example — email seo@x.example";
    const comment = buildState({ event: "comment", token: "valid", server: { text } });
    expect(comment.text?.excerpt).toBe("Great SEO backlinks at <url> — email <email>");
    expect(comment.text?.links).toBe(1);
    expect(buildState({ event: "login", token: "valid", server: { text } }).text).toBeUndefined();
    expect(buildState({ event: "comment", token: "valid", server: { text: "   " } }).text).toBeUndefined();
  });

  it("works with consent off (no per-field detail)", () => {
    const noConsent: BrowserSignals = { ...humanBrowser, consent: false };
    delete (noConsent as { fields?: unknown }).fields;
    const s = buildState({ event: "signup", token: "valid", browser: noConsent });
    expect(s.behavior?.fields).toBeUndefined();
    expect(s.behavior?.pasted_fields).toBeUndefined();
    expect(s.behavior?.typing).toBeDefined();
  });

  it("never contains raw IP hashes, email domains or account-identifying values", () => {
    const s = buildState({
      event: "form_submit",
      token: "valid",
      browser: humanBrowser,
      edge: humanEdge,
      server: { ...humanServer, account: { ...humanServer.account, email_domain: "secret-corp.example" } },
    });
    const json = JSON.stringify(s);
    expect(json).not.toContain(humanEdge.ip_hash);
    expect(json).not.toContain("secret-corp");
    expect(json).not.toContain("7922");
  });

  it("omits pow when absent and includes it otherwise", () => {
    expect(buildState({ event: "login", token: "valid", pow: "absent" }).pow).toBeUndefined();
    expect(buildState({ event: "login", token: "valid", pow: "failed" }).pow).toBe("failed");
  });

  it(`stays within the ${STATE_TOKEN_BUDGET}-token budget in the worst case`, () => {
    const worst = buildState({
      event: "comment",
      token: "expired",
      pow: "replayed",
      browser: { ...headlessBrowser, fields: Array.from({ length: 64 }, () => headlessBrowser.fields![0]!), automation: { webdriver: true, headless_hints: ["no_plugins", "no_languages", "swiftshader_webgl", "zero_outer_size", "headless_ua", "missing_chrome_runtime", "permissions_mismatch"], viewport_consistent: false } },
      edge: {
        ...swarmEdge,
        known_bad_ip: true,
        declared_agent: { status: "verified", name: "a-very-long-agent-name-that-goes-on-and-on-forever-and-ever" },
        header_anomalies: ["missing_accept_language", "ua_client_hints_mismatch", "unusual_header_order", "missing_sec_fetch", "http1_modern_ua"],
      },
      server: {
        account: { age_days: 0, email_domain: "mailinator.com" },
        history: { events_30d: 500, blocked_30d: 300, stepped_up_30d: 300 },
        text: "Ωmega ".repeat(2_000),
      },
    });
    expect(estimateTokens(worst)).toBeLessThanOrEqual(STATE_TOKEN_BUDGET);
    expect(State.safeParse(worst).success).toBe(true);
  });

  it("is deterministic", () => {
    const a = buildState({ event: "signup", token: "valid", browser: humanBrowser, edge: humanEdge, server: humanServer });
    const b = buildState({ event: "signup", token: "valid", browser: humanBrowser, edge: humanEdge, server: humanServer });
    expect(a).toEqual(b);
  });
});
