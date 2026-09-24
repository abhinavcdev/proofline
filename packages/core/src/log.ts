/**
 * Redaction for anything that might be logged. API keys, tokens, secrets and
 * auth headers are masked; a key-looking string keeps only its public prefix.
 */

const SENSITIVE_KEY = /(^|_|-)(api[_-]?key|key|token|secret|password|authorization|cookie|signature|otp|code)$/i;
const KEY_LIKE = /\b(pl_(?:pk|sk)_(?:live|test)_)[A-Za-z0-9]{8,}\b/g;

export function maskSecret(value: string): string {
  const m = /^(pl_(?:pk|sk)_(?:live|test)_)/.exec(value);
  return m ? `${m[1]}…` : "[redacted]";
}

export function redact<T>(value: T, depth = 0): T {
  if (depth > 8) return "[depth]" as T;
  if (typeof value === "string") return value.replace(KEY_LIKE, "$1…") as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) && v != null ? (typeof v === "string" ? maskSecret(v) : "[redacted]") : redact(v, depth + 1);
    }
    return out as T;
  }
  return value;
}
