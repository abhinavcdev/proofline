import { describe, expect, it } from "vitest";
import {
  MemoryReplayGuard,
  base64url,
  fromBase64url,
  issuePowChallenge,
  leadingZeroBits,
  maskSecret,
  redact,
  signToken,
  solvePow,
  verifyPow,
  verifyToken,
} from "../src/index.js";
import { SECRET } from "./fixtures.js";

const OTHER = "another-secret-another-secret-another-01";
const T0 = 1_780_000_000_000;

describe("signed tokens", () => {
  it("round-trips claims", async () => {
    const t = await signToken(SECRET, "signal", { project: "p1", n: 3 }, { ttlSeconds: 300, now: T0 });
    const v = await verifyToken<{ project: string; n: number }>(SECRET, t, "signal", T0 + 1000);
    expect(v.ok && v.claims.data).toEqual({ project: "p1", n: 3 });
    expect(v.ok && v.claims.exp - v.claims.iat).toBe(300);
  });

  it("rejects tampered payloads and signatures", async () => {
    const t = await signToken(SECRET, "signal", { admin: false }, { ttlSeconds: 300, now: T0 });
    const [p, body, sig] = t.split(".") as [string, string, string];
    const forged = base64url(new TextEncoder().encode(new TextDecoder().decode(fromBase64url(body)).replace("false", "true")));
    expect(await verifyToken(SECRET, `${p}.${forged}.${sig}`, "signal", T0)).toEqual({ ok: false, reason: "bad_signature" });
    expect(await verifyToken(SECRET, `${p}.${body}.${sig.slice(0, -2)}AA`, "signal", T0)).toEqual({ ok: false, reason: "bad_signature" });
    expect(await verifyToken(OTHER, t, "signal", T0)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects expired tokens and wrong types", async () => {
    const t = await signToken(SECRET, "signal", {}, { ttlSeconds: 60, now: T0 });
    expect(await verifyToken(SECRET, t, "signal", T0 + 60_000)).toEqual({ ok: false, reason: "expired" });
    expect(await verifyToken(SECRET, t, "pass", T0)).toEqual({ ok: false, reason: "wrong_type" });
  });

  it.each(["", "garbage", "pl1.a", "pl2.a.b", "pl1.***.abc", `pl1.${"a".repeat(9000)}.b`])("rejects malformed %j", async (t) => {
    const v = await verifyToken(SECRET, t, "signal", T0);
    expect(v.ok).toBe(false);
  });

  it("supports key rotation", async () => {
    const t = await signToken(OTHER, "signal", {}, { ttlSeconds: 60, now: T0 });
    expect((await verifyToken([SECRET, OTHER], t, "signal", T0)).ok).toBe(true);
  });

  it("refuses short secrets", async () => {
    await expect(signToken("short", "x", {}, { ttlSeconds: 1 })).rejects.toThrow(/at least 32/);
  });

  it("replay guard allows a jti once and forgets it after expiry", async () => {
    let now = T0;
    const g = new MemoryReplayGuard(() => now);
    const exp = T0 / 1000 + 60;
    expect(await g.consume("a", exp)).toBe(true);
    expect(await g.consume("a", exp)).toBe(false);
    now = T0 + 61_000;
    expect(await g.consume("b", exp + 120)).toBe(true);
    expect(await g.consume("a", exp + 120)).toBe(true);
  });
});

describe("proof-of-work", () => {
  it("counts leading zero bits", () => {
    expect(leadingZeroBits(new Uint8Array([0, 0, 0xff]))).toBe(16);
    expect(leadingZeroBits(new Uint8Array([0x0f]))).toBe(4);
    expect(leadingZeroBits(new Uint8Array([0x80]))).toBe(0);
    expect(leadingZeroBits(new Uint8Array([0, 1]))).toBe(15);
  });

  it("issues, solves and verifies once", async () => {
    const guard = new MemoryReplayGuard();
    const c = await issuePowChallenge(SECRET, { bits: 8 });
    const nonce = await solvePow(c.salt, c.bits);
    expect(await verifyPow(SECRET, c.token, nonce, guard)).toBe("passed");
    expect(await verifyPow(SECRET, c.token, nonce, guard)).toBe("replayed");
  });

  it("rejects wrong nonces, forged challenges, weak difficulty and absent solutions", async () => {
    const guard = new MemoryReplayGuard();
    const c = await issuePowChallenge(SECRET, { bits: 12 });
    // With 12 bits, a random fixed nonce is overwhelmingly likely to fail; pick one that does.
    let bad = "x";
    for (let i = 0; i < 50; i++) {
      bad = `bad${i}`;
      if (leadingZeroBits(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${c.salt}:${bad}`)))) < 12) break;
    }
    expect(await verifyPow(SECRET, c.token, bad, guard)).toBe("failed");
    expect(await verifyPow(OTHER, c.token, "0", guard)).toBe("failed");
    const weak = await issuePowChallenge(SECRET, { bits: 4 });
    expect(await verifyPow(SECRET, weak.token, await solvePow(weak.salt, 4), guard, { minBits: 10 })).toBe("failed");
    expect(await verifyPow(SECRET, undefined, undefined, guard)).toBe("absent");
    expect(await verifyPow(SECRET, c.token, "x".repeat(64), guard)).toBe("failed");
  });

  it("validates difficulty bounds", async () => {
    await expect(issuePowChallenge(SECRET, { bits: 0 })).rejects.toThrow();
    await expect(issuePowChallenge(SECRET, { bits: 40 })).rejects.toThrow();
  });
});

describe("log redaction", () => {
  it("masks secrets by key name and keeps only key prefixes", () => {
    const out = redact({
      headers: { authorization: "Bearer abc", "x-api-key": "pl_sk_live_abcdefghijklmnop" },
      signal_token: "pl1.aaa.bbb",
      TYPESAFE_API_KEY: "tsk_123",
      nested: [{ secret: "s", ok: 1 }],
      note: "used key pl_sk_test_ABCDEFGH12345678 today",
      event_type: "signup",
    });
    expect(out).toEqual({
      headers: { authorization: "[redacted]", "x-api-key": "pl_sk_live_…" },
      signal_token: "[redacted]",
      TYPESAFE_API_KEY: "[redacted]",
      nested: [{ secret: "[redacted]", ok: 1 }],
      note: "used key pl_sk_test_… today",
      event_type: "signup",
    });
    expect(maskSecret("anything")).toBe("[redacted]");
  });
});
