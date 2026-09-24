import { OTP_LENGTH } from "./ladder.js";

const enc = new TextEncoder();

/** Uniform 6-digit code (rejection sampling, no modulo bias). */
export function generateOtp(): string {
  const max = 10 ** OTP_LENGTH;
  const limit = Math.floor(0xffffffff / max) * max;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0]! < limit) return String(buf[0]! % max).padStart(OTP_LENGTH, "0");
  }
}

/** Stored form of a code, bound to its challenge so hashes can't be reused across challenges. */
export async function hashOtp(challengeId: string, code: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`otp:${challengeId}:${code}`)));
  return Array.from(d, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison for equal-length hex digests. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** "ada@gmail.com" → "a••@gmail.com", for showing where a code was sent. */
export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 1)}${"•".repeat(Math.max(2, Math.min(6, local.length - 1)))}@${domain}`;
}

export function isPlausibleEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
