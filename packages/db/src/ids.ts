import { base64url } from "@proofline/core";

/** UUIDv7 (RFC 9562): 48-bit ms timestamp + random, so ids sort by time. */
export function uuidv7(nowMs: number = Date.now()): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let ts = nowMs;
  for (let i = 5; i >= 0; i--) {
    b[i] = ts % 256;
    ts = Math.floor(ts / 256);
  }
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type KeyScope = "publishable" | "secret";
export type KeyEnv = "live" | "test";

const SCOPE_PREFIX: Record<KeyScope, string> = { publishable: "pl_pk", secret: "pl_sk" };
export const API_KEY_RE = /^pl_(pk|sk)_(live|test)_[A-Za-z0-9_-]{24,64}$/;

export function scopeOfKey(key: string): KeyScope | null {
  const m = API_KEY_RE.exec(key);
  return m ? (m[1] === "pk" ? "publishable" : "secret") : null;
}

/** New API key. Only the hash is stored; the plaintext is shown once. */
export async function generateApiKey(scope: KeyScope, env: KeyEnv = "test"): Promise<{ key: string; prefix: string; hash: string }> {
  const secret = base64url(crypto.getRandomValues(new Uint8Array(24)));
  const key = `${SCOPE_PREFIX[scope]}_${env}_${secret}`;
  return { key, prefix: key.slice(0, SCOPE_PREFIX[scope].length + env.length + 6), hash: await hashApiKey(key) };
}

export async function hashApiKey(key: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
  return Array.from(d, (x) => x.toString(16).padStart(2, "0")).join("");
}
