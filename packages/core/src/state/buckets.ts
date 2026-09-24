import type { z } from "zod";
import type { AgeBucket, CountBucket, RateBucket, TimeBucket } from "../types/state.js";

type Time = z.infer<typeof TimeBucket>;
type Count = z.infer<typeof CountBucket>;
type Rate = z.infer<typeof RateBucket>;
type Age = z.infer<typeof AgeBucket>;

export function timeBucket(ms: number): Time {
  if (ms < 2_000) return "<2s";
  if (ms < 5_000) return "2-5s";
  if (ms < 30_000) return "5-30s";
  if (ms < 300_000) return "30s-5m";
  return ">5m";
}

export function countBucket(n: number): Count {
  if (n <= 0) return "0";
  if (n <= 10) return "1-10";
  if (n <= 50) return "11-50";
  if (n <= 200) return "51-200";
  return ">200";
}

/** Thresholds are requests per trailing minute. */
export const RATE_THRESHOLDS = {
  ip: { elevated: 6, burst: 30 },
  asn: { elevated: 60, burst: 300 },
  fingerprint: { elevated: 10, burst: 50 },
} as const;

export function rateBucket(n: number, t: { elevated: number; burst: number }): Rate {
  if (n >= t.burst) return "burst";
  if (n >= t.elevated) return "elevated";
  return "normal";
}

export function ageBucket(days: number): Age {
  if (days < 1 / 24) return "new";
  if (days < 1) return "<1d";
  if (days < 7) return "1-7d";
  if (days < 30) return "7-30d";
  if (days < 365) return "30-365d";
  return ">1y";
}

/** Mean inter-key interval → cadence. Humans rarely sustain < 35 ms between keys. */
export function cadenceBucket(meanMs: number): "robotic" | "fast" | "normal" | "slow" {
  if (meanMs < 35) return "robotic";
  if (meanMs < 90) return "fast";
  if (meanMs < 400) return "normal";
  return "slow";
}

/** Coefficient of variation of inter-key intervals. Scripts with fixed delays score ~0. */
export function variabilityBucket(meanMs: number, varMs2: number): "none" | "low" | "normal" | "high" {
  if (meanMs <= 0) return "none";
  const cv = Math.sqrt(varMs2) / meanMs;
  if (cv < 0.05) return "none";
  if (cv < 0.25) return "low";
  if (cv < 1.5) return "normal";
  return "high";
}

export function pointerBucket(
  type: "mouse" | "touch" | "pen" | "none",
  events: number,
  entropy: number,
): "none" | "linear" | "low" | "natural" | "touch" {
  if (type === "touch") return "touch";
  if (type === "none" || events === 0) return "none";
  if (entropy < 0.2) return "linear";
  if (entropy < 0.5) return "low";
  return "natural";
}
