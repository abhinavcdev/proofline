import { and, desc, eq, isNull } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { EventPolicy, type EventType, type Mode } from "@proofline/core";
import { apiKeys, decisionEvents, feedback, organizations, policies, projects } from "./schema.js";
import { generateApiKey, uuidv7, type KeyEnv, type KeyScope } from "./ids.js";

export interface Project {
  id: string;
  org_id: string;
  name: string;
  mode: Mode;
  retention_days: number;
  questions_version: string;
  jev_timeout_ms: number;
  allowed_origins: string[];
  pow_bits: number | null;
}

export interface ApiKeyRecord {
  id: string;
  project_id: string;
  prefix: string;
  scope: KeyScope;
  revoked_at: Date | null;
}

export type DecisionEventRecord = typeof decisionEvents.$inferInsert;
export type StoredDecisionEvent = typeof decisionEvents.$inferSelect;

export type FeedbackLabel = "false_positive" | "confirmed_bot";
export interface FeedbackInput {
  project_id: string;
  decision_id: string;
  label: FeedbackLabel;
  note?: string | undefined;
}

export interface CreateProjectInput {
  name: string;
  org_id?: string;
  org_name?: string;
  mode?: Mode;
  allowed_origins?: string[];
  pow_bits?: number | null;
  questions_version?: string;
  jev_timeout_ms?: number;
}

/**
 * Persistence used by the API. `DrizzleStore` covers Postgres and PGlite;
 * `MemoryStore` is for unit tests and quick local runs.
 */
export interface Store {
  findApiKeyByHash(hash: string): Promise<{ key: ApiKeyRecord; project: Project } | null>;
  /** Latest policy version for the event type, or null to use the default policy. */
  getPolicy(projectId: string, eventType: EventType): Promise<EventPolicy | null>;
  putPolicy(projectId: string, policy: EventPolicy): Promise<void>;
  insertDecision(event: DecisionEventRecord): Promise<void>;
  getDecision(projectId: string, id: string): Promise<StoredDecisionEvent | null>;
  listDecisions(projectId: string, opts?: { limit?: number }): Promise<StoredDecisionEvent[]>;
  insertFeedback(input: FeedbackInput): Promise<{ id: string }>;
  createProject(input: CreateProjectInput): Promise<Project>;
  /** Returns the plaintext key once. */
  createApiKey(projectId: string, scope: KeyScope, env?: KeyEnv): Promise<{ key: string; record: ApiKeyRecord }>;
  revokeApiKey(id: string): Promise<void>;
}

function projectDefaults(input: CreateProjectInput, orgId: string): Project {
  return {
    id: `prj_${uuidv7().replace(/-/g, "").slice(0, 20)}`,
    org_id: orgId,
    name: input.name,
    mode: input.mode ?? "shadow",
    retention_days: 30,
    questions_version: input.questions_version ?? "v1",
    jev_timeout_ms: input.jev_timeout_ms ?? 400,
    allowed_origins: input.allowed_origins ?? [],
    pow_bits: input.pow_bits ?? null,
  };
}

const NULLABLE_DECISION_COLUMNS = [
  "rung", "fallback_reason", "p_automated", "actor_type", "actor_conf", "risk_level", "risk_conf", "intent",
  "p_templated", "ip_hash", "asn", "country", "ja4", "ua_family", "declared_agent", "t_verify_ms", "t_edge_ms",
  "t_state_ms", "t_decide_ms", "t_policy_ms",
] as const;

/** What Postgres would return for an inserted row: omitted nullable columns become null. */
function decisionDefaults(e: DecisionEventRecord): StoredDecisionEvent {
  const out: Record<string, unknown> = Object.fromEntries(NULLABLE_DECISION_COLUMNS.map((c) => [c, null]));
  for (const [k, v] of Object.entries(e)) if (v !== undefined) out[k] = v;
  return out as StoredDecisionEvent;
}

export class MemoryStore implements Store {
  readonly projects = new Map<string, Project>();
  readonly keys = new Map<string, ApiKeyRecord & { hash: string }>();
  readonly policies = new Map<string, EventPolicy[]>();
  readonly decisions: StoredDecisionEvent[] = [];
  readonly feedback: Array<FeedbackInput & { id: string }> = [];

  async findApiKeyByHash(hash: string) {
    for (const k of this.keys.values()) {
      if (k.hash === hash && !k.revoked_at) {
        const project = this.projects.get(k.project_id);
        const { hash: _h, ...key } = k;
        return project ? { key, project } : null;
      }
    }
    return null;
  }

  async getPolicy(projectId: string, eventType: EventType) {
    return this.policies.get(`${projectId}:${eventType}`)?.at(-1) ?? null;
  }

  async putPolicy(projectId: string, policy: EventPolicy) {
    const k = `${projectId}:${policy.event_type}`;
    this.policies.set(k, [...(this.policies.get(k) ?? []), EventPolicy.parse(policy)]);
  }

  async insertDecision(event: DecisionEventRecord) {
    this.decisions.push(decisionDefaults(event));
  }

  async getDecision(projectId: string, id: string) {
    return this.decisions.find((d) => d.id === id && d.project_id === projectId) ?? null;
  }

  async listDecisions(projectId: string, opts: { limit?: number } = {}) {
    return this.decisions
      .filter((d) => d.project_id === projectId)
      .sort((a, b) => b.ts.getTime() - a.ts.getTime())
      .slice(0, opts.limit ?? 100);
  }

  async insertFeedback(input: FeedbackInput) {
    const id = uuidv7();
    this.feedback.push({ ...input, id });
    return { id };
  }

  async createProject(input: CreateProjectInput) {
    const p = projectDefaults(input, input.org_id ?? "org_default");
    this.projects.set(p.id, p);
    return p;
  }

  async createApiKey(projectId: string, scope: KeyScope, env: KeyEnv = "test") {
    const { key, prefix, hash } = await generateApiKey(scope, env);
    const record: ApiKeyRecord = { id: `key_${uuidv7().replace(/-/g, "").slice(0, 20)}`, project_id: projectId, prefix, scope, revoked_at: null };
    this.keys.set(record.id, { ...record, hash });
    return { key, record };
  }

  async revokeApiKey(id: string) {
    const k = this.keys.get(id);
    if (k) k.revoked_at = new Date();
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyPgDatabase = PgDatabase<PgQueryResultHKT, any>;

export class DrizzleStore implements Store {
  constructor(private readonly db: AnyPgDatabase) {}

  async findApiKeyByHash(hash: string) {
    const rows = await this.db
      .select({ key: apiKeys, project: projects })
      .from(apiKeys)
      .innerJoin(projects, eq(apiKeys.project_id, projects.id))
      .where(and(eq(apiKeys.key_hash, hash), isNull(apiKeys.revoked_at)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const { key_hash: _h, created_at: _c, ...key } = row.key;
    const { created_at: _pc, ...project } = row.project;
    return { key: { ...key, scope: key.scope as KeyScope }, project: { ...project, mode: project.mode as Mode } };
  }

  async getPolicy(projectId: string, eventType: EventType) {
    const rows = await this.db
      .select({ policy: policies.policy })
      .from(policies)
      .where(and(eq(policies.project_id, projectId), eq(policies.event_type, eventType)))
      .orderBy(desc(policies.version))
      .limit(1);
    return rows[0] ? EventPolicy.parse(rows[0].policy) : null;
  }

  async putPolicy(projectId: string, policy: EventPolicy) {
    const p = EventPolicy.parse(policy);
    await this.db.insert(policies).values({ project_id: projectId, event_type: p.event_type, version: p.version, policy: p });
  }

  async insertDecision(event: DecisionEventRecord) {
    await this.db.insert(decisionEvents).values(event);
  }

  async getDecision(projectId: string, id: string) {
    const rows = await this.db
      .select()
      .from(decisionEvents)
      .where(and(eq(decisionEvents.project_id, projectId), eq(decisionEvents.id, id)))
      .limit(1);
    return rows[0] ?? null;
  }

  async listDecisions(projectId: string, opts: { limit?: number } = {}) {
    return this.db
      .select()
      .from(decisionEvents)
      .where(eq(decisionEvents.project_id, projectId))
      .orderBy(desc(decisionEvents.ts))
      .limit(opts.limit ?? 100);
  }

  async insertFeedback(input: FeedbackInput) {
    const id = uuidv7();
    await this.db.insert(feedback).values({ id, ...input, note: input.note ?? null });
    return { id };
  }

  async createProject(input: CreateProjectInput) {
    let orgId = input.org_id;
    if (!orgId) {
      orgId = `org_${uuidv7().replace(/-/g, "").slice(0, 20)}`;
      await this.db.insert(organizations).values({ id: orgId, name: input.org_name ?? input.name });
    }
    const p = projectDefaults(input, orgId);
    await this.db.insert(projects).values(p);
    return p;
  }

  async createApiKey(projectId: string, scope: KeyScope, env: KeyEnv = "test") {
    const { key, prefix, hash } = await generateApiKey(scope, env);
    const record: ApiKeyRecord = { id: `key_${uuidv7().replace(/-/g, "").slice(0, 20)}`, project_id: projectId, prefix, scope, revoked_at: null };
    await this.db.insert(apiKeys).values({ ...record, key_hash: hash });
    return { key, record };
  }

  async revokeApiKey(id: string) {
    await this.db.update(apiKeys).set({ revoked_at: new Date() }).where(eq(apiKeys.id, id));
  }
}
