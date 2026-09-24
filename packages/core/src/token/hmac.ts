/**
 * Compact HMAC-SHA256 tokens (Web Crypto only; runs in Workers, Node, browsers).
 *
 *   pl1.<base64url(JSON claims)>.<base64url(signature)>
 *
 * Claims carry a type, issue/expiry times and a unique id for one-time use.
 * Verification accepts a list of secrets so signing keys can be rotated.
 */

export interface TokenClaims<T> {
  typ: string;
  iat: number;
  exp: number;
  jti: string;
  data: T;
}

export type VerifyFailure = "malformed" | "bad_signature" | "expired" | "wrong_type";
export type VerifyResult<T> = { ok: true; claims: TokenClaims<T> } | { ok: false; reason: VerifyFailure };

const PREFIX = "pl1";
const enc = new TextEncoder();
const dec = new TextDecoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

export function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("invalid base64url");
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomId(bytes = 16): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function hmacKey(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) throw new Error("Signing secret must be at least 32 characters");
  let key = keyCache.get(secret);
  if (!key) {
    key = crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    if (keyCache.size > 16) keyCache.clear();
    keyCache.set(secret, key);
  }
  return key;
}

export async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(message)));
}

export interface SignOptions {
  ttlSeconds: number;
  now?: number;
  jti?: string;
}

export async function signToken<T>(secret: string, typ: string, data: T, opts: SignOptions): Promise<string> {
  const iat = Math.floor((opts.now ?? Date.now()) / 1000);
  const claims: TokenClaims<T> = { typ, iat, exp: iat + opts.ttlSeconds, jti: opts.jti ?? randomId(), data };
  const body = base64url(enc.encode(JSON.stringify(claims)));
  const sig = await hmacSha256(secret, `${PREFIX}.${body}`);
  return `${PREFIX}.${body}.${base64url(sig)}`;
}

export async function verifyToken<T = unknown>(
  secrets: string | readonly string[],
  token: string,
  typ: string,
  now: number = Date.now(),
): Promise<VerifyResult<T>> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX || token.length > 8192) return { ok: false, reason: "malformed" };
  const [, body, sig] = parts as [string, string, string];

  let sigBytes: Uint8Array<ArrayBuffer>;
  try {
    sigBytes = fromBase64url(sig);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  let valid = false;
  for (const secret of typeof secrets === "string" ? [secrets] : secrets) {
    // crypto.subtle.verify compares in constant time.
    if (await crypto.subtle.verify("HMAC", await hmacKey(secret), sigBytes, enc.encode(`${PREFIX}.${body}`))) {
      valid = true;
      break;
    }
  }
  if (!valid) return { ok: false, reason: "bad_signature" };

  let claims: TokenClaims<T>;
  try {
    claims = JSON.parse(dec.decode(fromBase64url(body))) as TokenClaims<T>;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof claims !== "object" || claims === null || typeof claims.exp !== "number" || typeof claims.jti !== "string") {
    return { ok: false, reason: "malformed" };
  }
  if (claims.typ !== typ) return { ok: false, reason: "wrong_type" };
  if (Math.floor(now / 1000) >= claims.exp) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}

/** One-time-use tracking for token ids. Production uses a Durable Object/KV; tests use memory. */
export interface ReplayGuard {
  /** Returns true the first time a jti is seen, false on reuse. */
  consume(jti: string, expiresAtSec: number): Promise<boolean>;
}

export class MemoryReplayGuard implements ReplayGuard {
  readonly #seen = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}

  async consume(jti: string, expiresAtSec: number): Promise<boolean> {
    const nowSec = Math.floor(this.now() / 1000);
    for (const [k, exp] of this.#seen) if (exp <= nowSec) this.#seen.delete(k);
    if (this.#seen.has(jti)) return false;
    this.#seen.set(jti, expiresAtSec);
    return true;
  }
}
