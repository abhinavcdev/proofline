import { afterAll, describe, expect, it } from "vitest";
import { defaultPolicy } from "@proofline/core";
import { API_KEY_RE, MemoryStore, hashApiKey, scopeOfKey, uuidv7, type DecisionEventRecord, type Store } from "../src/index.js";
import { createPgliteStore } from "../src/node.js";

describe("ids", () => {
  it("uuidv7 is time-ordered and well-formed", () => {
    const a = uuidv7(1_000);
    const b = uuidv7(2_000);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });
});

const closers: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const c of closers) await c();
});

const backends: Array<[string, () => Promise<Store>]> = [
  ["memory", async () => new MemoryStore()],
  [
    "pglite",
    async () => {
      const { store, close } = await createPgliteStore();
      closers.push(close);
      return store;
    },
  ],
];

describe.each(backends)("%s store", (_name, make) => {
  const decision = (projectId: string, over: Partial<DecisionEventRecord> = {}): DecisionEventRecord => ({
    id: uuidv7(),
    ts: new Date(),
    project_id: projectId,
    event_type: "signup",
    action: "block",
    effective_action: "allow",
    mode: "shadow",
    risk: 3,
    matched: "confident_automation",
    decision_source: "mock",
    questions_version: "v1",
    policy_version: 1,
    token_status: "valid",
    p_automated: 0.97,
    actor_type: "credential_stuffer",
    answers: { is_automated: { type: "noul", p: 0.97 } },
    reasons: [{ code: "x", message: "y" }],
    state: { v: 1, event: "signup", sdk: "valid" },
    t_total_ms: 12.5,
    ...over,
  });

  it("creates projects and keys, finds keys by hash, honours revocation", async () => {
    const store = await make();
    const p = await store.createProject({ name: "Crumb & Co.", allowed_origins: ["http://localhost:3000"] });
    expect(p.mode).toBe("shadow");
    const sk = await store.createApiKey(p.id, "secret");
    const pk = await store.createApiKey(p.id, "publishable");
    expect(sk.key).toMatch(API_KEY_RE);
    expect(scopeOfKey(sk.key)).toBe("secret");
    expect(scopeOfKey(pk.key)).toBe("publishable");
    expect(sk.key.startsWith(sk.record.prefix)).toBe(true);

    const found = await store.findApiKeyByHash(await hashApiKey(sk.key));
    expect(found?.project).toMatchObject({ id: p.id, allowed_origins: ["http://localhost:3000"], mode: "shadow" });
    expect(found?.key.scope).toBe("secret");
    expect(JSON.stringify(found)).not.toContain(sk.key);

    await store.revokeApiKey(sk.record.id);
    expect(await store.findApiKeyByHash(await hashApiKey(sk.key))).toBeNull();
    expect(await store.findApiKeyByHash(await hashApiKey(pk.key))).not.toBeNull();
  });

  it("returns the latest policy version", async () => {
    const store = await make();
    const p = await store.createProject({ name: "p" });
    expect(await store.getPolicy(p.id, "login")).toBeNull();
    const base = defaultPolicy("login");
    await store.putPolicy(p.id, base);
    await store.putPolicy(p.id, { ...base, version: base.version + 1, rules: [] });
    const got = await store.getPolicy(p.id, "login");
    expect(got?.version).toBe(base.version + 1);
    expect(got?.rules).toEqual([]);
  });

  it("appends decisions, scopes reads to the project, and stores feedback", async () => {
    const store = await make();
    const p = await store.createProject({ name: "p" });
    const other = await store.createProject({ name: "q" });
    const d = decision(p.id);
    await store.insertDecision(d);
    await store.insertDecision(decision(p.id, { id: uuidv7(Date.now() + 5), action: "allow" }));

    const got = await store.getDecision(p.id, d.id);
    expect(got).toMatchObject({ id: d.id, action: "block", effective_action: "allow", p_automated: expect.closeTo(0.97, 5), rung: null });
    expect(got?.answers).toEqual(d.answers);
    expect(await store.getDecision(other.id, d.id)).toBeNull();
    expect((await store.listDecisions(p.id)).length).toBe(2);

    const f = await store.insertFeedback({ project_id: p.id, decision_id: d.id, label: "false_positive", note: "real customer" });
    expect(f.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("runs the challenge state machine with compare-and-set", async () => {
    const store = await make();
    const p = await store.createProject({ name: "p" });
    const c = await store.createChallenge({
      id: "ch_test_1",
      project_id: p.id,
      decision_id: uuidv7(),
      event_type: "login",
      rung: "email_otp",
      state: "pending",
      attempts: 0,
      sends: 0,
      last_sent_at: null,
      account_ref: null,
      contact_email: "ada@gmail.com",
      secret: null,
      tried: [],
      expires_at: new Date(Date.now() + 60_000),
    });
    expect(c.version).toBe(0);
    const u1 = await store.updateChallenge(c.id, 0, { state: "issued", secret: { otp_hash: "abc" }, sends: 1 });
    expect(u1).toMatchObject({ version: 1, state: "issued", secret: { otp_hash: "abc" } });
    // A stale writer loses.
    expect(await store.updateChallenge(c.id, 0, { attempts: 1 })).toBeNull();
    const u2 = await store.updateChallenge(c.id, 1, { state: "passed", secret: null, contact_email: null, tried: ["email_otp"] });
    expect(u2).toMatchObject({ version: 2, state: "passed", secret: null, contact_email: null, tried: ["email_otp"] });
    expect(await store.getChallenge(p.id, c.id)).toMatchObject({ state: "passed" });
    expect(await store.getChallenge("other", c.id)).toBeNull();
  });

  it("stores end-user passkeys per account and review items", async () => {
    const store = await make();
    const p = await store.createProject({ name: "p" });
    await store.addPasskey({ project_id: p.id, credential_id: "cred1", account_ref: "acct", public_key: "pk", counter: 0, transports: ["internal"] });
    await expect(store.addPasskey({ project_id: p.id, credential_id: "cred1", account_ref: "acct", public_key: "pk", counter: 0, transports: [] })).rejects.toThrow();
    await store.updatePasskeyCounter(p.id, "cred1", 7);
    expect(await store.listPasskeys(p.id, "acct")).toEqual([
      { project_id: p.id, credential_id: "cred1", account_ref: "acct", public_key: "pk", counter: 7, transports: ["internal"] },
    ]);
    expect(await store.listPasskeys(p.id, "other")).toEqual([]);

    const r = await store.createReviewItem({ project_id: p.id, challenge_id: "ch_1", decision_id: uuidv7(), event_type: "signup" });
    expect(r.state).toBe("open");
    expect((await store.listReviewItems(p.id, "open")).map((x) => x.id)).toEqual([r.id]);
  });
});
