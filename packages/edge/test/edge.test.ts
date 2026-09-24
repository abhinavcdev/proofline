import { describe, expect, it } from "vitest";
import {
  HARD_RATE_LIMITS,
  MemoryRateCounter,
  SlidingWindowCounters,
  StaticIpList,
  WebBotAuthVerifier,
  classifyAsn,
  cloudflareContext,
  collectEdgeSignals,
  createEdgeGuard,
  hashIp,
  headerAnomalies,
  headerFingerprint,
  jwkThumbprint,
  normalizeIp,
  signWebBotAuth,
  uaFamily,
  vercelContext,
} from "../src/index.js";

const SALT = "salt-secret-salt-secret-salt-secret-01";
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const chromeHeaders = () =>
  new Headers({
    "user-agent": CHROME_UA,
    "accept-language": "en-US,en;q=0.9",
    "sec-ch-ua": '"Chromium";v="140", "Google Chrome";v="140", "Not;A=Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "cross-site",
  });

describe("ip hashing", () => {
  const day = Date.UTC(2026, 8, 24, 12);
  it("is stable within a day, different across days, and never the raw ip", async () => {
    const a = await hashIp("203.0.113.9", SALT, day);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toContain("203");
    expect(await hashIp("203.0.113.9", SALT, day + 3_600_000)).toBe(a);
    expect(await hashIp("203.0.113.9", SALT, day + 86_400_000)).not.toBe(a);
    expect(await hashIp("203.0.113.10", SALT, day)).not.toBe(a);
  });

  it("normalises equivalent spellings", async () => {
    expect(normalizeIp("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(normalizeIp("2001:DB8::1")).toBe(normalizeIp("2001:db8:0:0:0:0:0:1"));
    expect(normalizeIp("not-an-ip")).toBeNull();
    expect(normalizeIp("1.2.3.256")).toBeNull();
    expect(await hashIp("2001:DB8::1", SALT, day)).toBe(await hashIp("2001:db8:0::1", SALT, day));
  });
});

describe("StaticIpList", () => {
  const list = new StaticIpList(["198.51.100.0/24", "203.0.113.7", "2001:db8:bad::/48"]);
  it("matches v4 and v6 CIDRs", () => {
    expect(list.isBad("198.51.100.200")).toBe(true);
    expect(list.isBad("198.51.101.1")).toBe(false);
    expect(list.isBad("203.0.113.7")).toBe(true);
    expect(list.isBad("203.0.113.8")).toBe(false);
    expect(list.isBad("2001:db8:bad:1::5")).toBe(true);
    expect(list.isBad("2001:db8:bae::1")).toBe(false);
    expect(list.isBad("garbage")).toBe(false);
  });
  it("rejects invalid CIDRs", () => {
    expect(() => new StaticIpList(["10.0.0.0/33"])).toThrow();
  });
});

describe("classifyAsn", () => {
  it("uses known ASNs, then org keywords, else unknown", () => {
    expect(classifyAsn(16509)).toBe("datacenter");
    expect(classifyAsn(21928)).toBe("mobile");
    expect(classifyAsn(99999, "Example Hosting Ltd")).toBe("datacenter");
    expect(classifyAsn(99999, "Example Cable Broadband")).toBe("residential");
    expect(classifyAsn(99999)).toBe("unknown");
    expect(classifyAsn(undefined)).toBe("unknown");
  });
});

describe("headers", () => {
  it("classifies user agents", () => {
    expect(uaFamily(CHROME_UA)).toBe("chrome");
    expect(uaFamily("curl/8.5.0")).toBe("curl");
    expect(uaFamily("python-requests/2.32")).toBe("python");
    expect(uaFamily(CHROME_UA.replace("Chrome/", "HeadlessChrome/"))).toBe("headless_chrome");
    expect(uaFamily("Mozilla/5.0 (compatible; GPTBot/1.2)")).toBe("bot");
    expect(uaFamily(null)).toBe("none");
  });

  it("finds no anomalies for a normal Chrome request", () => {
    expect(headerAnomalies({ headers: chromeHeaders(), httpProtocol: "HTTP/2", direct: true })).toEqual([]);
  });

  it("flags client-hint mismatches, missing metadata and HTTP/1 browsers", () => {
    const h = chromeHeaders();
    h.delete("accept-language");
    h.delete("sec-fetch-mode");
    h.set("sec-ch-ua", '"Chromium";v="120"');
    expect(headerAnomalies({ headers: h, httpProtocol: "HTTP/1.1", direct: true }).sort()).toEqual([
      "http1_modern_ua",
      "missing_accept_language",
      "missing_sec_fetch",
      "ua_client_hints_mismatch",
    ]);
  });

  it("skips direct-only checks for forwarded headers", () => {
    const h = new Headers({ "user-agent": CHROME_UA, "accept-language": "en" });
    expect(headerAnomalies({ headers: h, direct: false })).toEqual([]);
  });

  it("fingerprints by header set, ignoring infrastructure headers", async () => {
    const a = chromeHeaders();
    const b = chromeHeaders();
    b.set("cf-connecting-ip", "1.2.3.4");
    b.set("x-forwarded-for", "1.2.3.4");
    expect(await headerFingerprint(a)).toBe(await headerFingerprint(b));
    expect(await headerFingerprint(new Headers({ "user-agent": "curl/8" }))).not.toBe(await headerFingerprint(a));
    expect(await headerFingerprint(a, ["user-agent", "accept"])).not.toBe(await headerFingerprint(a, ["accept", "user-agent"]));
  });
});

describe("rate counters", () => {
  it("counts within the window and decays across windows", () => {
    const c = new SlidingWindowCounters(60_000);
    const t0 = 60_000 * 100;
    for (let i = 0; i < 9; i++) c.hit("k", t0 + i);
    expect(c.hit("k", t0 + 10)).toBe(10);
    // Halfway through the next window: ~half of the previous window still counts.
    expect(c.hit("k", t0 + 90_000)).toBe(6);
    // Two windows later everything has expired.
    expect(c.hit("k", t0 + 250_000)).toBe(1);
  });

  it("bounds memory", () => {
    const c = new SlidingWindowCounters(60_000, 100);
    for (let i = 0; i < 1000; i++) c.hit(`k${i}`, 0);
    expect(c.size).toBeLessThanOrEqual(100);
  });
});

async function agentKeys() {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as { crv: string; kty: string; x: string };
  const keyid = await jwkThumbprint(jwk);
  const directory = { keys: [{ kty: "OKP", crv: "Ed25519", x: jwk.x }] };
  const fetchDir = (async (url: string) =>
    String(url) === "https://agent.example/.well-known/http-message-signatures-directory"
      ? new Response(JSON.stringify(directory))
      : new Response("no", { status: 404 })) as unknown as typeof fetch;
  return { kp, keyid, fetchDir };
}

describe("Web Bot Auth", () => {
  const NOW = Date.UTC(2026, 8, 24, 12);
  const target = () => new Request("https://api.proofline.test/v1/signals", { method: "POST", headers: { "user-agent": "ExampleAgent/1.0" } });

  it("verifies a signed request from an allowlisted directory", async () => {
    const { kp, keyid, fetchDir } = await agentKeys();
    const v = new WebBotAuthVerifier({ trusted: [{ name: "example-agent", directory: "https://agent.example" }], fetch: fetchDir, now: () => NOW });
    const req = await signWebBotAuth(target(), { privateKey: kp.privateKey, keyid, agentOrigin: "https://agent.example", nowMs: NOW });
    expect(await v.verify(req)).toEqual({ status: "verified", name: "example-agent" });
  });

  it("rejects tampering, expiry, unknown directories and unknown keys", async () => {
    const { kp, keyid, fetchDir } = await agentKeys();
    const trusted = [{ name: "example-agent", directory: "https://agent.example" }];
    const v = new WebBotAuthVerifier({ trusted, fetch: fetchDir, now: () => NOW });
    const signed = await signWebBotAuth(target(), { privateKey: kp.privateKey, keyid, agentOrigin: "https://agent.example", nowMs: NOW });

    const otherHost = new Request("https://evil.test/v1/signals", { method: "POST", headers: signed.headers });
    expect(await v.verify(otherHost)).toMatchObject({ status: "unverified_claim", reason: "bad_signature" });

    const later = new WebBotAuthVerifier({ trusted, fetch: fetchDir, now: () => NOW + 3_600_000 });
    expect(await later.verify(signed)).toMatchObject({ status: "unverified_claim", reason: "expired" });

    const untrusted = new WebBotAuthVerifier({ trusted: [{ name: "x", directory: "https://other.example" }], fetch: fetchDir, now: () => NOW });
    expect(await untrusted.verify(signed)).toMatchObject({ status: "unverified_claim", reason: "directory_not_trusted" });

    const wrongKey = await signWebBotAuth(target(), { privateKey: kp.privateKey, keyid: "nope", agentOrigin: "https://agent.example", nowMs: NOW });
    expect(await v.verify(wrongKey)).toMatchObject({ status: "unverified_claim", reason: "unknown_key" });
  });

  it("treats agent-looking user agents without signatures as unverified claims", async () => {
    const v = new WebBotAuthVerifier({ trusted: [] });
    const r = new Request("https://x.test/", { headers: { "user-agent": "Mozilla/5.0 (compatible; GPTBot/1.2)" } });
    expect((await v.verify(r)).status).toBe("unverified_claim");
    expect((await v.verify(new Request("https://x.test/", { headers: { "user-agent": CHROME_UA } }))).status).toBe("none");
  });
});

describe("collectEdgeSignals", () => {
  const cfRequest = (extra: Record<string, unknown> = {}) => {
    const r = new Request("https://api.proofline.test/v1/signals", { method: "POST", headers: chromeHeaders() });
    r.headers.set("cf-connecting-ip", "203.0.113.9");
    Object.defineProperty(r, "cf", { value: { asn: 7922, asOrganization: "Comcast Cable", country: "US", httpProtocol: "HTTP/2", ...extra } });
    return r;
  };

  it("builds privacy-safe signals from a Cloudflare request", async () => {
    const { signals, rate_limited } = await collectEdgeSignals(cloudflareContext(cfRequest()), { saltSecret: SALT, rate: new MemoryRateCounter() });
    expect(signals).toMatchObject({ asn: 7922, asn_class: "residential", country: "US", ua_family: "chrome", header_anomalies: [], known_bad_ip: false, declared_agent: { status: "none" }, rate: { ip_1m: 1, asn_1m: 1, fp_1m: 1 } });
    expect(JSON.stringify(signals)).not.toContain("203.0.113.9");
    expect(rate_limited).toEqual([]);
  });

  it("flags known-bad IPs and hard rate limits; enforce mode returns 403", async () => {
    const deps = { saltSecret: SALT, rate: new MemoryRateCounter(() => 0), ipReputation: new StaticIpList(["203.0.113.0/24"]) };
    const guard = createEdgeGuard({ mode: "enforce", deps });
    const r = await guard(cloudflareContext(cfRequest()));
    expect(r.signals.known_bad_ip).toBe(true);
    expect(r.response?.status).toBe(403);

    const shadow = createEdgeGuard({ mode: "shadow", deps: { saltSecret: SALT, rate: new MemoryRateCounter(() => 0) } });
    let last;
    for (let i = 0; i <= HARD_RATE_LIMITS.ip; i++) last = await shadow(cloudflareContext(cfRequest()));
    expect(last!.rate_limited).toContain("ip");
    expect(last!.response).toBeUndefined();
  });

  it("gives Cloudflare-verified bots their own lane", async () => {
    const rate = new MemoryRateCounter(() => 0);
    await collectEdgeSignals(cloudflareContext(cfRequest()), { saltSecret: SALT, rate });
    const { signals } = await collectEdgeSignals(cloudflareContext(cfRequest({ botManagement: { verifiedBot: true, ja4: "t13d1516h2_abc" } })), { saltSecret: SALT, rate });
    expect(signals.declared_agent.status).toBe("verified");
    expect(signals.ja4).toBe("t13d1516h2_abc");
    expect(signals.rate.ip_1m).toBe(1);
  });

  it("reads Vercel geo headers", async () => {
    const req = new Request("https://site.test/", { headers: { ...Object.fromEntries(chromeHeaders()), "x-forwarded-for": "198.51.100.4, 10.0.0.1", "x-vercel-ip-country": "de" } });
    const { signals } = await collectEdgeSignals(vercelContext(req), { saltSecret: SALT, rate: new MemoryRateCounter() });
    expect(signals.country).toBe("DE");
    expect(signals.asn_class).toBe("unknown");
    expect(signals.rate.ip_1m).toBe(1);
  });
});
