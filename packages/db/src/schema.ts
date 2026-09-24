import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Proofline Postgres schema. Dashboard auth tables (users, sessions, passkeys)
 * are added in M4 through the Better Auth Drizzle adapter.
 */

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  created_at: createdAt(),
});

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  org_id: text("org_id")
    .notNull()
    .references(() => organizations.id),
  name: text("name").notNull(),
  /** `shadow` | `enforce`. New projects start in shadow mode. */
  mode: text("mode").notNull().default("shadow"),
  retention_days: integer("retention_days").notNull().default(30),
  questions_version: text("questions_version").notNull().default("v1"),
  jev_timeout_ms: integer("jev_timeout_ms").notNull().default(400),
  /** Origins allowed to call /v1/signals with this project's publishable key. */
  allowed_origins: jsonb("allowed_origins").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  /** Leading-zero bits for the optional browser proof-of-work; null disables it. */
  pow_bits: integer("pow_bits"),
  created_at: createdAt(),
});

export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    project_id: text("project_id")
      .notNull()
      .references(() => projects.id),
    /** Public prefix shown in the dashboard and logs, e.g. `pl_sk_live_AbCd`. */
    prefix: text("prefix").notNull(),
    /** sha256(key), hex. The key itself is never stored. */
    key_hash: text("key_hash").notNull(),
    scope: text("scope").notNull(),
    created_at: createdAt(),
    revoked_at: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("api_keys_hash_idx").on(t.key_hash)],
);

export const policies = pgTable(
  "policies",
  {
    project_id: text("project_id")
      .notNull()
      .references(() => projects.id),
    event_type: text("event_type").notNull(),
    version: integer("version").notNull(),
    /** A full `EventPolicy` document. */
    policy: jsonb("policy").notNull(),
    created_at: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.project_id, t.event_type, t.version] })],
);

/**
 * Append-only, denormalised decision log: no foreign keys and no updates, so it
 * can move to a columnar store later. `state` is the compact, privacy-safe state.
 */
export const decisionEvents = pgTable(
  "decision_events",
  {
    id: uuid("id").primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    project_id: text("project_id").notNull(),
    event_type: text("event_type").notNull(),
    action: text("action").notNull(),
    effective_action: text("effective_action").notNull(),
    mode: text("mode").notNull(),
    rung: text("rung"),
    risk: integer("risk").notNull(),
    matched: text("matched").notNull(),
    decision_source: text("decision_source").notNull(),
    fallback_reason: text("fallback_reason"),
    questions_version: text("questions_version").notNull(),
    policy_version: integer("policy_version").notNull(),
    token_status: text("token_status").notNull(),

    p_automated: real("p_automated"),
    actor_type: text("actor_type"),
    actor_conf: real("actor_conf"),
    risk_level: integer("risk_level"),
    risk_conf: real("risk_conf"),
    intent: text("intent"),
    p_templated: real("p_templated"),
    answers: jsonb("answers").notNull(),

    reasons: jsonb("reasons").notNull(),
    state: jsonb("state").notNull(),
    ip_hash: text("ip_hash"),
    asn: integer("asn"),
    country: text("country"),
    ja4: text("ja4"),
    ua_family: text("ua_family"),
    declared_agent: text("declared_agent"),

    t_total_ms: real("t_total_ms").notNull(),
    t_verify_ms: real("t_verify_ms"),
    t_edge_ms: real("t_edge_ms"),
    t_state_ms: real("t_state_ms"),
    t_decide_ms: real("t_decide_ms"),
    t_policy_ms: real("t_policy_ms"),
  },
  (t) => [
    index("decision_events_project_ts_idx").on(t.project_id, t.ts),
    index("decision_events_project_event_ts_idx").on(t.project_id, t.event_type, t.ts),
    index("decision_events_project_action_ts_idx").on(t.project_id, t.action, t.ts),
  ],
);

export const feedback = pgTable(
  "feedback",
  {
    id: uuid("id").primaryKey(),
    project_id: text("project_id").notNull(),
    decision_id: uuid("decision_id").notNull(),
    /** `false_positive` | `confirmed_bot`. */
    label: text("label").notNull(),
    note: text("note"),
    created_at: createdAt(),
  },
  (t) => [index("feedback_project_decision_idx").on(t.project_id, t.decision_id)],
);

/** Daily rollup of decision_events, kept after raw events expire. Filled by the retention job (M5). */
export const usageDaily = pgTable(
  "usage_daily",
  {
    project_id: text("project_id").notNull(),
    day: text("day").notNull(),
    event_type: text("event_type").notNull(),
    action: text("action").notNull(),
    shadow: boolean("shadow").notNull(),
    count: integer("count").notNull(),
  },
  (t) => [primaryKey({ columns: [t.project_id, t.day, t.event_type, t.action, t.shadow] })],
);
