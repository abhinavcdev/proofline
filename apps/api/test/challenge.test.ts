import { describe, expect, it } from "vitest";
import { MemoryEmailSender, defaultPolicy, solvePow, type Rung } from "@proofline/core";
import { ORIGIN, flush, getToken, harness, humanSignals, type Harness } from "./helpers.js";
import { SoftAuthenticator } from "./soft-authenticator.js";

/** A policy that always steps up to `rung` (the rule matches any is_automated answer). */
async function forceRung(h: Harness, rung: Rung, event: "signup" | "login" = "signup") {
  const base = defaultPolicy(event);
  await h.store.putPolicy(h.project.id, {
    ...base,
    version: base.version + 1,
    rules: [{ id: "always", when: [{ type: "prob", q: "is_automated", op: "gte", value: 0 }], then: { action: "step_up", rung }, explain: "test" }],
  });
}

async function stepUp(h: Harness, rung: Rung, extra: Record<string, unknown> = {}, event: "signup" | "login" = "signup") {
  await forceRung(h, rung, event);
  const { body: t } = await getToken(h, humanSignals, { event_type: event });
  const res = await h.app.request("/v1/assess", {
    method: "POST",
    headers: { authorization: `Bearer ${h.sk}` },
    body: JSON.stringify({ event_type: event, signal_token: t.token, ...extra }),
  });
  return (await res.json()) as { action: string; decision_id: string; challenge?: { id: string; rung: Rung } };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests poke into rung-specific payloads
type Json = Record<string, any>;

const call = async (h: Harness, path: string, body: Record<string, unknown>, origin = ORIGIN) => {
  const res = await h.app.request(`/v1/challenge/${path}`, { method: "POST", headers: { origin, "content-type": "text/plain" }, body: JSON.stringify({ key: h.pk, ...body }) });
  return { status: res.status, body: (await res.json()) as Json };
};

const verify = async (h: Harness, pass_token: string, key = h.sk) =>
  (await (await h.app.request("/v1/challenge/verify", { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify({ pass_token }) })).json()) as Record<string, unknown>;

describe("assess → challenge", () => {
  it("creates a challenge only for enforce-mode step-ups", async () => {
    const shadow = await harness({ mode: "shadow" });
    expect((await stepUp(shadow, "pow")).challenge).toBeUndefined();
    const enforce = await harness({ mode: "enforce" });
    const r = await stepUp(enforce, "pow");
    expect(r.action).toBe("step_up:pow");
    expect(r.challenge).toMatchObject({ id: expect.stringMatching(/^ch_/), rung: "pow" });
  });

  it("climbs past rungs the user can't complete", async () => {
    const h = await harness({ mode: "enforce" });
    // No contact email → email_otp is unavailable → review.
    expect((await stepUp(h, "email_otp")).action).toBe("step_up:review");
    expect((await stepUp(h, "email_otp", { contact: { email: "ada@gmail.com" } })).action).toBe("step_up:email_otp");
  });

  it("never logs the contact email", async () => {
    const h = await harness({ mode: "enforce" });
    const r = await stepUp(h, "email_otp", { contact: { email: "ada@gmail.com" } });
    await flush();
    expect(JSON.stringify(await h.store.getDecision(h.project.id, r.decision_id))).not.toContain("ada@gmail.com");
  });
});

describe("pow rung", () => {
  it("passes with a valid solution; the pass token verifies once", async () => {
    const h = await harness({ mode: "enforce" });
    const { challenge } = await stepUp(h, "pow");
    const start = await call(h, "start", { challenge_id: challenge!.id });
    expect(start.body).toMatchObject({ state: "issued", rung: "pow", payload: { bits: 18 } });
    const nonce = await solvePow(start.body.payload.salt, start.body.payload.bits);
    const done = await call(h, "complete", { challenge_id: challenge!.id, response: { nonce } });
    expect(done.body).toMatchObject({ state: "passed", pass_token: expect.stringMatching(/^pl1\./) });

    expect(await verify(h, done.body.pass_token)).toMatchObject({ valid: true, rung: "pow", event_type: "signup", challenge_id: challenge!.id });
    expect(await verify(h, done.body.pass_token)).toEqual({ valid: false, reason: "replayed" });
    // Completing again does not mint another pass.
    expect((await call(h, "complete", { challenge_id: challenge!.id, response: { nonce } })).body.state).toBe("used");
  }, 30_000);

  it("wrong solutions count as attempts and eventually move down the ladder", async () => {
    const h = await harness({ mode: "enforce" });
    const { challenge } = await stepUp(h, "pow", { contact: { email: "ada@gmail.com" } });
    await call(h, "start", { challenge_id: challenge!.id });
    let last;
    for (let i = 0; i < 5; i++) last = await call(h, "complete", { challenge_id: challenge!.id, response: { nonce: "nope" } });
    expect(last!.body).toMatchObject({ rung: "email_otp", state: "issued", error: "wrong_answer" });
  });
});

describe("email_otp rung", () => {
  const setup = async () => {
    const email = new MemoryEmailSender();
    let t = Date.now();
    const h = await harness({ mode: "enforce", deps: { emailSender: email, now: () => t } });
    const { challenge } = await stepUp(h, "email_otp", { contact: { email: "ada@gmail.com" } });
    return { h, email, id: challenge!.id, advance: (ms: number) => (t += ms) };
  };

  it("sends a code, accepts it, and clears the address", async () => {
    const { h, email, id } = await setup();
    const start = await call(h, "start", { challenge_id: id });
    expect(start.body.payload).toMatchObject({ rung: "email_otp", sent_to: "a••@gmail.com", code_length: 6, sent: true, resend_after_s: 30 });
    const code = email.lastCode("ada@gmail.com")!;
    expect((await call(h, "complete", { challenge_id: id, response: { code: "000000" === code ? "111111" : "000000" } })).body).toMatchObject({
      state: "issued",
      error: "wrong_answer",
      attempts_left: 4,
    });
    const ok = await call(h, "complete", { challenge_id: id, response: { code: ` ${code} ` } });
    expect(ok.body.state).toBe("passed");
    const stored = (h.store as unknown as { challenges: Map<string, { contact_email: unknown; secret: unknown }> }).challenges.get(id)!;
    expect(stored.contact_email).toBeNull();
    expect(stored.secret).toBeNull();
  });

  it("rate limits resends and caps them", async () => {
    const { h, email, id, advance } = await setup();
    await call(h, "start", { challenge_id: id });
    const early = await call(h, "start", { challenge_id: id });
    expect(early.body.payload).toMatchObject({ sent: false });
    expect(email.outbox).toHaveLength(1);
    advance(31_000);
    expect((await call(h, "start", { challenge_id: id })).body.payload.sent).toBe(true);
    advance(31_000);
    await call(h, "start", { challenge_id: id });
    advance(31_000);
    const capped = await call(h, "start", { challenge_id: id });
    expect(capped.body.payload).toMatchObject({ sent: false, resend_after_s: -1 });
    expect(email.outbox).toHaveLength(3);
    // Only the newest code works.
    const codes = email.outbox.map((m) => /(\d{6})/.exec(m.text)![1]!);
    if (codes[0] !== codes[2]) expect((await call(h, "complete", { challenge_id: id, response: { code: codes[0] } })).body.error).toBe("wrong_answer");
    expect((await call(h, "complete", { challenge_id: id, response: { code: codes[2] } })).body.state).toBe("passed");
  });

  it("five wrong codes fall through to review", async () => {
    const { h, id } = await setup();
    await call(h, "start", { challenge_id: id });
    let last;
    for (let i = 0; i < 5; i++) last = await call(h, "complete", { challenge_id: id, response: { code: "abcdef" } });
    expect(last!.body).toMatchObject({ state: "review", rung: "review" });
    expect(await h.store.listReviewItems(h.project.id, "open")).toHaveLength(1);
  });

  it("expires", async () => {
    const { h, id, advance } = await setup();
    await call(h, "start", { challenge_id: id });
    advance(16 * 60_000);
    expect((await call(h, "complete", { challenge_id: id, response: { code: "123456" } })).body.state).toBe("expired");
  });
});

describe("passkey rung", () => {
  it("registers on signup, then authenticates on a later login", async () => {
    const h = await harness({ mode: "enforce" });
    const auth = new SoftAuthenticator(ORIGIN);
    const account = { context: { account: { id: "user-42" } } };

    const reg = await stepUp(h, "passkey", account);
    expect(reg.action).toBe("step_up:passkey");
    const s1 = await call(h, "start", { challenge_id: reg.challenge!.id });
    expect(s1.body.payload).toMatchObject({ rung: "passkey", mode: "register", options: { rp: { id: "shop.test" } } });
    const created = await auth.register(s1.body.payload.options);
    expect((await call(h, "complete", { challenge_id: reg.challenge!.id, response: { credential: created } })).body.state).toBe("passed");

    const login = await stepUp(h, "passkey", account, "login");
    expect(login.action).toBe("step_up:passkey");
    const s2 = await call(h, "start", { challenge_id: login.challenge!.id });
    expect(s2.body.payload.mode).toBe("authenticate");
    // Assertion made for another origin is rejected, and a fresh challenge is issued.
    const phished = await auth.assert(s2.body.payload.options, { origin: "https://evil.test" });
    const bad = await call(h, "complete", { challenge_id: login.challenge!.id, response: { credential: phished } });
    expect(bad.body).toMatchObject({ state: "issued", error: "not_verified" });
    const good = await auth.assert(bad.body.payload.options);
    expect((await call(h, "complete", { challenge_id: login.challenge!.id, response: { credential: good } })).body.state).toBe("passed");
  });

  it("a login with no registered passkey falls back to email", async () => {
    const h = await harness({ mode: "enforce" });
    const r = await stepUp(h, "passkey", { context: { account: { id: "nobody" } }, contact: { email: "x@example.com" } }, "login");
    expect(r.action).toBe("step_up:email_otp");
  });

  it("'use another way' moves to email, then review", async () => {
    const email = new MemoryEmailSender();
    const h = await harness({ mode: "enforce", deps: { emailSender: email } });
    const r = await stepUp(h, "passkey", { context: { account: { id: "u1" } }, contact: { email: "u1@example.com" } });
    await call(h, "start", { challenge_id: r.challenge!.id });
    const f1 = await call(h, "fallback", { challenge_id: r.challenge!.id });
    expect(f1.body).toMatchObject({ rung: "email_otp", state: "issued", payload: { sent: true } });
    expect(email.outbox).toHaveLength(1);
    const f2 = await call(h, "fallback", { challenge_id: r.challenge!.id });
    expect(f2.body).toMatchObject({ state: "review" });
  });
});

describe("id_verify and review rungs", () => {
  it("id_verify is unavailable in the MVP (stub verifier) and falls through to review", async () => {
    const h = await harness({ mode: "enforce" });
    const r = await stepUp(h, "pow");
    // The policy never picks id_verify without the capability, so move the stored challenge onto it directly.
    const ch = (await h.store.getChallenge(h.project.id, r.challenge!.id))!;
    await h.store.updateChallenge(ch.id, ch.version, { rung: "id_verify" });
    const s = await call(h, "start", { challenge_id: ch.id });
    expect(s.body).toMatchObject({ state: "review", rung: "review" });
    expect(await h.store.listReviewItems(h.project.id)).toHaveLength(1);
  });

  it("review is terminal and queues one review item", async () => {
    const h = await harness({ mode: "enforce" });
    const r = await stepUp(h, "review");
    expect(r.action).toBe("step_up:review");
    const s = await call(h, "start", { challenge_id: r.challenge!.id });
    expect(s.body).toMatchObject({ state: "review", payload: { message: expect.stringContaining("review") } });
    await call(h, "start", { challenge_id: r.challenge!.id });
    expect(await h.store.listReviewItems(h.project.id)).toHaveLength(1);
  });
});

describe("challenge route security", () => {
  it("checks origin, key scope, project and id format", async () => {
    const h = await harness({ mode: "enforce" });
    const { challenge } = await stepUp(h, "pow");
    expect((await call(h, "start", { challenge_id: challenge!.id }, "https://evil.test")).status).toBe(403);
    expect((await call(h, "start", { challenge_id: challenge!.id, key: h.sk })).status).toBe(403);
    expect((await call(h, "start", { challenge_id: "ch_" + "x".repeat(20) })).status).toBe(404);
    expect((await call(h, "start", { challenge_id: "../etc" })).status).toBe(400);

    const other = await harness({ mode: "enforce" });
    expect((await call(other, "start", { challenge_id: challenge!.id })).status).toBe(404);
  });

  it("rejects pass tokens from another project or forged ones", async () => {
    const a = await harness({ mode: "enforce" });
    const b = await harness({ mode: "enforce" });
    const { challenge } = await stepUp(a, "pow");
    const s = await call(a, "start", { challenge_id: challenge!.id });
    const nonce = await solvePow(s.body.payload.salt, s.body.payload.bits);
    const { body } = await call(a, "complete", { challenge_id: challenge!.id, response: { nonce } });
    expect(await verify(b, body.pass_token)).toEqual({ valid: false, reason: "invalid" });
    expect(await verify(a, body.pass_token.slice(0, -4) + "AAAA")).toEqual({ valid: false, reason: "invalid" });
    expect((await a.app.request("/v1/challenge/verify", { method: "POST", headers: { authorization: `Bearer ${a.pk}` }, body: "{}" })).status).toBe(403);
  }, 30_000);
});
