import type { PowStatus } from "../types/signals.js";
import { randomId, signToken, verifyToken, type ReplayGuard } from "../token/hmac.js";

/**
 * Hashcash-style proof-of-work: find a nonce such that
 * SHA-256("<salt>:<nonce>") has at least `bits` leading zero bits.
 * The challenge is a signed token, so the server keeps no state until a
 * solution is redeemed (then the jti is consumed to stop reuse).
 */

export const POW_TOKEN_TYPE = "pow";

export interface PowChallengeData {
  salt: string;
  bits: number;
}

const enc = new TextEncoder();

export function leadingZeroBits(bytes: Uint8Array): number {
  let n = 0;
  for (const b of bytes) {
    if (b === 0) {
      n += 8;
      continue;
    }
    return n + Math.clz32(b) - 24;
  }
  return n;
}

export async function powHash(salt: string, nonce: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`${salt}:${nonce}`)));
}

export async function issuePowChallenge(
  secret: string,
  opts: { bits: number; ttlSeconds?: number; now?: number },
): Promise<{ token: string; salt: string; bits: number }> {
  if (!Number.isInteger(opts.bits) || opts.bits < 1 || opts.bits > 28) throw new Error("bits must be 1..28");
  const salt = randomId(12);
  const token = await signToken<PowChallengeData>(secret, POW_TOKEN_TYPE, { salt, bits: opts.bits }, {
    ttlSeconds: opts.ttlSeconds ?? 300,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  return { token, salt, bits: opts.bits };
}

/** Brute-force solver. The browser SDK runs this in a Web Worker. */
export async function solvePow(salt: string, bits: number, maxIterations = 50_000_000): Promise<string> {
  for (let i = 0; i < maxIterations; i++) {
    const nonce = i.toString(36);
    if (leadingZeroBits(await powHash(salt, nonce)) >= bits) return nonce;
  }
  throw new Error("PoW not solved within iteration limit");
}

export async function verifyPow(
  secrets: string | readonly string[],
  token: string | undefined,
  nonce: string | undefined,
  replay: ReplayGuard,
  opts: { minBits?: number; now?: number } = {},
): Promise<PowStatus> {
  if (!token || nonce === undefined) return "absent";
  if (nonce.length > 32) return "failed";
  const v = await verifyToken<PowChallengeData>(secrets, token, POW_TOKEN_TYPE, opts.now);
  if (!v.ok) return "failed";
  const { salt, bits } = v.claims.data;
  if (bits < (opts.minBits ?? 0)) return "failed";
  if (leadingZeroBits(await powHash(salt, nonce)) < bits) return "failed";
  return (await replay.consume(v.claims.jti, v.claims.exp)) ? "passed" : "replayed";
}
