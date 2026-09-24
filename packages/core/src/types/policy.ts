import { z } from "zod";
import { EventType, Rung, type Action, type Mode } from "./events.js";
import { PowStatus, TokenStatus } from "./signals.js";

/**
 * Policies are data (stored as JSON per project + event type) so the
 * dashboard's threshold sliders can edit and replay them.
 */

export const Cmp = z.enum(["lt", "lte", "gt", "gte"]);
export type Cmp = z.infer<typeof Cmp>;

export const Condition = z.discriminatedUnion("type", [
  /** Probability of a noul "yes", or of a specific choice label. */
  z.object({ type: z.literal("prob"), q: z.string(), label: z.string().optional(), op: Cmp, value: z.number() }),
  /** Most likely choice label is one of `in`. */
  z.object({ type: z.literal("label"), q: z.string(), in: z.array(z.string()).min(1) }),
  /** Most likely score value. */
  z.object({ type: z.literal("score"), q: z.string(), op: Cmp, value: z.number() }),
  /** Provider confidence for a question. */
  z.object({ type: z.literal("confidence"), q: z.string(), op: Cmp, value: z.number() }),
]);
export type Condition = z.infer<typeof Condition>;

export const ActionSpec = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["allow", "block", "shadow_drop", "agent_lane"]) }),
  /** Step up to an explicit rung, or `level` rungs above invisible (1 = pow). */
  z.object({
    action: z.literal("step_up"),
    rung: Rung.optional(),
    level: z.number().int().min(1).max(Rung.options.length).optional(),
  }),
]);
export type ActionSpec = z.infer<typeof ActionSpec>;

export const Rule = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  /** All conditions must hold. */
  when: z.array(Condition).min(1),
  then: ActionSpec,
  /** Human-readable explanation used in decision reasons. */
  explain: z.string().max(200),
});
export type Rule = z.infer<typeof Rule>;

export const EventPolicy = z.object({
  version: z.number().int().min(1),
  event_type: EventType,
  /** Evaluated in order; first match wins. */
  rules: z.array(Rule).max(64),
  /** Used when no rule matches, indexed by risk level 0..3. */
  default_by_risk: z.tuple([ActionSpec, ActionSpec, ActionSpec, ActionSpec]),
  /** Applied (at minimum) when the browser signal token is missing or expired. */
  missing_token: ActionSpec,
  declared_agent: ActionSpec,
});
export type EventPolicy = z.infer<typeof EventPolicy>;

/** Deterministic checks. These run before and override any model output. */
export const DeterministicChecks = z.object({
  token: TokenStatus,
  pow: PowStatus,
  rate_limited: z.array(z.enum(["ip", "asn", "fingerprint", "api_key"])),
  known_bad_ip: z.boolean(),
  declared_agent: z.enum(["none", "verified", "unverified_claim"]),
});
export type DeterministicChecks = z.infer<typeof DeterministicChecks>;

/** Which step-up rungs this user can actually complete. */
export const Capabilities = z.object({
  passkey: z.boolean(),
  email: z.boolean(),
  id_verify: z.boolean(),
});
export type Capabilities = z.infer<typeof Capabilities>;

export const Reason = z.object({
  code: z.string(),
  message: z.string(),
  /** Relative importance; positive = suspicious, negative = human-like. */
  weight: z.number().optional(),
  evidence: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});
export type Reason = z.infer<typeof Reason>;

export interface PolicyDecision {
  action: Action;
  risk: 0 | 1 | 2 | 3;
  /** Rule id, or `hard:<check>`, `default_by_risk`, `missing_token`, `declared_agent`. */
  matched: string;
  reasons: Reason[];
}

export interface FinalDecision extends PolicyDecision {
  mode: Mode;
  /** What the caller should actually do. Always `allow` in shadow mode. */
  effective_action: Action;
}
