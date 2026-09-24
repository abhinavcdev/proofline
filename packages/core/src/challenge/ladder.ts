import type { Rung } from "../types/events.js";

/**
 * Step-up ladder rules. Every rung has an accessible fallback that does not
 * depend on the same ability or device; the chain always ends at `review`.
 */
export const FALLBACK: Readonly<Record<Rung, Rung | null>> = {
  pow: "email_otp",
  passkey: "email_otp",
  email_otp: "review",
  id_verify: "review",
  review: null,
};

export const CHALLENGE_TTL_S = 15 * 60;
export const PASS_TOKEN_TYPE = "pass";
export const PASS_TOKEN_TTL_S = 10 * 60;
export const MAX_ATTEMPTS = 5;
/** Harder than the invisible signup PoW (~1 s on a mid-range phone). */
export const CHALLENGE_POW_BITS = 18;

export const OTP_LENGTH = 6;
export const OTP_TTL_S = 10 * 60;
export const OTP_MAX_SENDS = 3;
export const OTP_RESEND_AFTER_S = 30;

export type ChallengeState = "pending" | "issued" | "passed" | "failed" | "review" | "expired";
export const TERMINAL_STATES: ReadonlySet<ChallengeState> = new Set(["passed", "failed", "review", "expired"]);

export interface PassTokenData {
  /** project */
  p: string;
  /** decision */
  d: string;
  /** challenge */
  c: string;
  e: string;
  r: Rung;
}

/**
 * Next rung the user can actually complete, skipping ones they lack the
 * means for (no email address → no OTP). Returns "review" at worst.
 */
export function nextAvailableRung(from: Rung, available: (r: Rung) => boolean): Rung {
  let r = FALLBACK[from];
  while (r && r !== "review" && !available(r)) r = FALLBACK[r];
  return r ?? "review";
}
