import { z } from "zod";
import { EventType } from "./events.js";
import { AsnClass, EmailDomainType, HeaderAnomaly, HeadlessHint, PowStatus, TokenStatus } from "./signals.js";

/**
 * The compact state sent to the decision provider. Buckets instead of raw
 * numbers, short enums, and only what carries signal. Kept under ~600 tokens.
 */

export const TimeBucket = z.enum(["<2s", "2-5s", "5-30s", "30s-5m", ">5m"]);
export const CountBucket = z.enum(["0", "1-10", "11-50", "51-200", ">200"]);
export const RateBucket = z.enum(["normal", "elevated", "burst"]);
export const AgeBucket = z.enum(["new", "<1d", "1-7d", "7-30d", "30-365d", ">1y"]);

export const State = z.object({
  v: z.literal(1),
  event: EventType,
  /** Status of the browser signal token. `missing` usually means no SDK ran. */
  sdk: TokenStatus,
  behavior: z
    .object({
      time_to_submit: TimeBucket,
      fields: z.number().int().min(0).max(64).optional(),
      typing: z
        .object({
          keys: CountBucket,
          cadence: z.enum(["robotic", "fast", "normal", "slow"]).optional(),
          variability: z.enum(["none", "low", "normal", "high"]).optional(),
          corrections: z.enum(["0", "1-2", "3+"]),
        })
        .optional(),
      pastes: z.enum(["0", "1", "2+"]),
      /** Fraction of filled fields that were pasted rather than typed. */
      pasted_fields: z.enum(["none", "some", "all"]).optional(),
      pointer: z.enum(["none", "linear", "low", "natural", "touch"]),
      focus_changes: CountBucket,
    })
    .optional(),
  automation: z
    .object({
      webdriver: z.literal(true).optional(),
      headless_hints: z.array(HeadlessHint).optional(),
      viewport_mismatch: z.literal(true).optional(),
    })
    .optional(),
  network: z
    .object({
      asn_class: AsnClass,
      country: z.string().optional(),
      rate_ip: RateBucket,
      rate_asn: RateBucket,
      rate_fingerprint: RateBucket,
      header_anomalies: z.array(HeaderAnomaly).optional(),
      declared_agent: z.string().optional(),
      known_bad_ip: z.literal(true).optional(),
    })
    .optional(),
  account: z
    .object({
      age: AgeBucket.optional(),
      email: EmailDomainType.optional(),
      events_30d: CountBucket.optional(),
      blocked_30d: CountBucket.optional(),
      stepped_up_30d: CountBucket.optional(),
    })
    .optional(),
  pow: PowStatus.optional(),
  text: z
    .object({
      excerpt: z.string().max(400),
      length: z.enum(["short", "medium", "long"]),
      links: z.number().int().min(0),
      emails: z.number().int().min(0),
      phones: z.number().int().min(0),
    })
    .optional(),
});
export type State = z.infer<typeof State>;
