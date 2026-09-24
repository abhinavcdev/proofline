import { and, desc, eq, isNull } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { EventPolicy, type ChallengeState, type EventType, type Mode, type Rung } from "@proofline/core";
import { apiKeys, challenges, decisionEvents, endUserPasskeys, feedback, organizations, policies, projects, reviewItems } from "./schema.js";
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

export interface Challenge {
  id: string;
  project_id: string;
  decision_id: string;
  event_type: EventType;
  rung: Rung;
  state: ChallengeState;
  version: number;
  attempts: number;
  sends: number;
  last_sent_at: Date | null;
  account_ref: string | null;
  contact_email: string | null;
  secret: Record<string, unknown> | null;
  tried: Rung[];
  expires_at: Date;
}

export type ChallengePatch = Partial<Omit<Challenge, "id" | "project_id" | "decision_id" | "event_type" | "version">>;

export interface EndUserPasskey {
  project_id: string;
  credential_id: string;
  account_ref: string;
  public_key: string;
  counter: number;
  transports: string[];
}

export interface ReviewItem {
  id: string;
  project_id: string;
  challenge_id: string;
  decision_id: string;
  event_type: EventType;
  state: "open" | "approved" | "rejected";
  created_at: Date;
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

  createChallenge(c: Omit<Challenge, "version">): Promise<Challenge>;
  getChallenge(projectId: string, id: string): Promise<Challenge | null>;
  /** Compare-and-set on `version`; returns the updated row, or null if it changed underneath us. */
  updateChallenge(id: string, expectedVersion: number, patch: ChallengePatch): Promise<Challenge | null>;

  listPasskeys(projectId: string, accountRef: string): Promise<EndUserPasskey[]>;
  addPasskey(p: EndUserPasskey): Promise<void>;
  updatePasskeyCounter(projectId: string, credentialId: string, counter: number): Promise<void>;

  createReviewItem(item: Omit<ReviewItem, "id" | "state" | "created_at">): Promise<ReviewItem>;
  listReviewItems(projectId: string, state?: ReviewItem["state"]): Promise<ReviewItem[]>;
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

  readonly challenges = new Map<string, Challenge>();
  readonly passkeys: EndUserPasskey[] = [];
  readonly reviews: ReviewItem[] = [];

  async createChallenge(c: Omit<Challenge, "version">) {
    const row = { ...c, version: 0, tried: [...c.tried] };
    this.challenges.set(c.id, row);
    return structuredClone(row);
  }

  async getChallenge(projectId: string, id: string) {
    const c = this.challenges.get(id);
    return c && c.project_id === projectId ? structuredClone(c) : null;
  }

  async updateChallenge(id: string, expectedVersion: number, patch: ChallengePatch) {
    const c = this.challenges.get(id);
    if (!c || c.version !== expectedVersion) return null;
    Object.assign(c, patch, { version: c.version + 1 });
    return structuredClone(c);
  }

  async listPasskeys(projectId: string, accountRef: string) {
    return this.passkeys.filter((p) => p.project_id === projectId && p.account_ref === accountRef).map((p) => ({ ...p }));
  }

  async addPasskey(p: EndUserPasskey) {
    if (this.passkeys.some((x) => x.project_id === p.project_id && x.credential_id === p.credential_id)) {
      throw new Error("duplicate credential");
    }
    this.passkeys.push({ ...p });
  }

  async updatePasskeyCounter(projectId: string, credentialId: string, counter: number) {
    const p = this.passkeys.find((x) => x.project_id === projectId && x.credential_id === credentialId);
    if (p) p.counter = counter;
  }

  async createReviewItem(item: Omit<ReviewItem, "id" | "state" | "created_at">) {
    const r: ReviewItem = { ...item, id: uuidv7(), state: "open", created_at: new Date() };
    this.reviews.push(r);
    return { ...r };
  }

  async listReviewItems(projectId: string, state?: ReviewItem["state"]) {
    return this.reviews.filter((r) => r.project_id === projectId && (!state || r.state === state)).map((r) => ({ ...r }));
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

  async createChallenge(c: Omit<Challenge, "version">) {
    const [row] = await this.db.insert(challenges).values({ ...c, version: 0 }).returning();
    return toChallenge(row!);
  }

  async getChallenge(projectId: string, id: string) {
    const rows = await this.db
      .select()
      .from(challenges)
      .where(and(eq(challenges.project_id, projectId), eq(challenges.id, id)))
      .limit(1);
    return rows[0] ? toChallenge(rows[0]) : null;
  }

  async updateChallenge(id: string, expectedVersion: number, patch: ChallengePatch) {
    const rows = await this.db
      .update(challenges)
      .set({ ...patch, version: expectedVersion + 1, updated_at: new Date() })
      .where(and(eq(challenges.id, id), eq(challenges.version, expectedVersion)))
      .returning();
    return rows[0] ? toChallenge(rows[0]) : null;
  }

  async listPasskeys(projectId: string, accountRef: string) {
    const rows = await this.db
      .select()
      .from(endUserPasskeys)
      .where(and(eq(endUserPasskeys.project_id, projectId), eq(endUserPasskeys.account_ref, accountRef)));
    return rows.map(({ created_at: _c, last_used_at: _l, ...p }) => p);
  }

  async addPasskey(p: EndUserPasskey) {
    await this.db.insert(endUserPasskeys).values(p);
  }

  async updatePasskeyCounter(projectId: string, credentialId: string, counter: number) {
    await this.db
      .update(endUserPasskeys)
      .set({ counter, last_used_at: new Date() })
      .where(and(eq(endUserPasskeys.project_id, projectId), eq(endUserPasskeys.credential_id, credentialId)));
  }

  async createReviewItem(item: Omit<ReviewItem, "id" | "state" | "created_at">) {
    const [row] = await this.db.insert(reviewItems).values({ ...item, id: uuidv7() }).returning();
    return toReview(row!);
  }

  async listReviewItems(projectId: string, state?: ReviewItem["state"]) {
    const rows = await this.db
      .select()
      .from(reviewItems)
      .where(state ? and(eq(reviewItems.project_id, projectId), eq(reviewItems.state, state)) : eq(reviewItems.project_id, projectId))
      .orderBy(desc(reviewItems.created_at));
    return rows.map(toReview);
  }
}

function toChallenge(row: typeof challenges.$inferSelect): Challenge {
  const { created_at: _c, updated_at: _u, ...c } = row;
  return {
    ...c,
    event_type: c.event_type as EventType,
    rung: c.rung as Rung,
    state: c.state as ChallengeState,
    secret: (c.secret as Record<string, unknown> | null) ?? null,
    tried: c.tried as Rung[],
  };
}

function toReview(row: typeof reviewItems.$inferSelect): ReviewItem {
  const { resolved_at: _r, ...r } = row;
  return { ...r, event_type: r.event_type as EventType, state: r.state as ReviewItem["state"] };
}
