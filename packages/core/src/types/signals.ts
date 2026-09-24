import { z } from "zod";

/**
 * Signals are the raw inputs to the state builder. Nothing here may contain
 * keystroke values, field contents or raw IPs. See PRIVACY.md.
 */

const Count = z.number().int().min(0).max(1_000_000);
const Ms = z.number().int().min(0).max(86_400_000);

export const FieldKind = z.enum(["text", "email", "password", "tel", "number", "textarea", "select", "other"]);
export type FieldKind = z.infer<typeof FieldKind>;

export const HeadlessHint = z.enum([
  "no_plugins",
  "no_languages",
  "swiftshader_webgl",
  "zero_outer_size",
  "headless_ua",
  "missing_chrome_runtime",
  "permissions_mismatch",
]);
export type HeadlessHint = z.infer<typeof HeadlessHint>;

/** Aggregates collected by @proofline/sdk-browser for one form interaction. */
export const BrowserSignals = z.object({
  v: z.literal(1),
  consent: z.boolean(),
  /** Page load → submit. */
  page_ms: Ms,
  /** Per-field aggregates, by position and input type only. Omitted when consent is off. */
  fields: z
    .array(
      z.object({
        kind: FieldKind,
        dwell_ms: Ms,
        keys: Count,
        corrections: Count,
        pastes: Count,
        focus: Count,
      }),
    )
    .max(64)
    .optional(),
  /** Inter-key interval stats across the form (Welford running mean/variance). */
  keys: z.object({
    count: Count,
    iki_mean_ms: z.number().min(0).max(60_000),
    iki_var_ms2: z.number().min(0).max(3.6e9),
    corrections: Count,
  }),
  pastes: Count,
  pointer: z.object({
    type: z.enum(["mouse", "touch", "pen", "none"]),
    events: Count,
    /** Normalised Shannon entropy of movement angle histogram, 0..1. */
    entropy: z.number().min(0).max(1),
  }),
  focus_blur: Count,
  automation: z.object({
    webdriver: z.boolean(),
    headless_hints: z.array(HeadlessHint).max(HeadlessHint.options.length),
    viewport_consistent: z.boolean(),
  }),
});
export type BrowserSignals = z.infer<typeof BrowserSignals>;

export const AsnClass = z.enum(["residential", "mobile", "datacenter", "unknown"]);
export type AsnClass = z.infer<typeof AsnClass>;

export const HeaderAnomaly = z.enum([
  "missing_accept_language",
  "ua_client_hints_mismatch",
  "unusual_header_order",
  "missing_sec_fetch",
  "http1_modern_ua",
]);
export type HeaderAnomaly = z.infer<typeof HeaderAnomaly>;

export const DeclaredAgent = z.object({
  status: z.enum(["none", "verified", "unverified_claim"]),
  name: z.string().max(64).optional(),
});
export type DeclaredAgent = z.infer<typeof DeclaredAgent>;

/** Network signals added by @proofline/edge. */
export const EdgeSignals = z.object({
  /** HMAC(daily_salt, ip), hex. Never the raw IP. */
  ip_hash: z.string().regex(/^[0-9a-f]{32}$/),
  asn: z.number().int().min(0).optional(),
  asn_class: AsnClass,
  country: z.string().regex(/^[A-Z]{2}$/).optional(),
  ja4: z.string().max(64).optional(),
  header_fp: z.string().max(64),
  header_anomalies: z.array(HeaderAnomaly).max(HeaderAnomaly.options.length),
  ua_family: z.string().max(32),
  /** Requests in the trailing minute. */
  rate: z.object({ ip_1m: Count, asn_1m: Count, fp_1m: Count }),
  declared_agent: DeclaredAgent,
  known_bad_ip: z.boolean(),
});
export type EdgeSignals = z.infer<typeof EdgeSignals>;

export const EmailDomainType = z.enum(["free", "corporate", "disposable", "edu", "unknown"]);
export type EmailDomainType = z.infer<typeof EmailDomainType>;

/** Context the customer's server passes to /v1/assess. */
export const ServerContext = z.object({
  account: z
    .object({
      age_days: z.number().min(0).max(100_000).optional(),
      /** Domain only, never the full address. Classified, then discarded. */
      email_domain: z.string().max(253).optional(),
      has_passkey: z.boolean().optional(),
      has_verified_email: z.boolean().optional(),
    })
    .optional(),
  history: z
    .object({
      events_30d: Count,
      blocked_30d: Count,
      stepped_up_30d: Count,
    })
    .optional(),
  /** Free text relevant to content checks (comment, contact message). Truncated before use. */
  text: z.string().max(10_000).optional(),
});
export type ServerContext = z.infer<typeof ServerContext>;

export const TokenStatus = z.enum(["valid", "missing", "expired", "invalid", "replayed"]);
export type TokenStatus = z.infer<typeof TokenStatus>;

export const PowStatus = z.enum(["passed", "failed", "replayed", "absent"]);
export type PowStatus = z.infer<typeof PowStatus>;
