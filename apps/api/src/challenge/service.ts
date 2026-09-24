import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import {
  CHALLENGE_POW_BITS,
  CHALLENGE_TTL_S,
  ConsoleEmailSender,
  FALLBACK,
  MAX_ATTEMPTS,
  OTP_LENGTH,
  OTP_MAX_SENDS,
  OTP_RESEND_AFTER_S,
  OTP_TTL_S,
  PASS_TOKEN_TTL_S,
  PASS_TOKEN_TYPE,
  StubIdVerifier,
  TERMINAL_STATES,
  base64url,
  fromBase64url,
  generateOtp,
  hashOtp,
  issuePowChallenge,
  maskEmail,
  nextAvailableRung,
  otpEmail,
  randomId,
  signToken,
  timingSafeEqual,
  verifyPow,
  type EventType,
  type PassTokenData,
  type Rung,
} from "@proofline/core";
import type { Challenge, ChallengePatch, Project } from "@proofline/db";
import type { ApiDeps } from "../deps.js";

/**
 * The step-up state machine.
 *
 *   pending ──start──▶ issued ──complete ok──▶ passed (pass token)
 *                        │  └─wrong answer──▶ issued (attempts+1)
 *                        └─too many / "another way" / unavailable──▶ next rung (issued) … ▶ review
 *   any non-terminal ──past expires_at──▶ expired
 *
 * Every write is a compare-and-set on `version`, so concurrent requests can't
 * double-spend attempts or passes.
 */

const CONSOLE_SENDER = new ConsoleEmailSender();
const STUB_ID = new StubIdVerifier();

export class ChallengeConflict extends Error {
  constructor() {
    super("Challenge changed concurrently");
  }
}

export interface ChallengeCtx {
  deps: ApiDeps;
  project: Project;
  /** Origin of the page running the challenge (already checked against the allowlist). */
  origin: string;
  now: number;
}

export type RungPayload =
  | { rung: "pow"; salt: string; bits: number }
  | { rung: "email_otp"; sent_to: string; code_length: number; resend_after_s: number; expires_in_s: number; sent: boolean }
  | { rung: "passkey"; mode: "register" | "authenticate"; options: unknown }
  | { rung: "id_verify"; url: string }
  | { rung: "review"; message: string };

export type ChallengeView =
  | { challenge_id: string; state: "issued"; rung: Rung; payload: RungPayload; attempts_left: number; can_fallback: boolean }
  | { challenge_id: string; state: "passed"; rung: Rung; pass_token: string }
  | { challenge_id: string; state: "review"; rung: "review"; payload: Extract<RungPayload, { rung: "review" }> }
  | { challenge_id: string; state: "failed" | "expired"; rung: Rung }
  /** Already passed; the pass token was issued once and is not issued again. */
  | { challenge_id: string; state: "used"; rung: Rung };

export type CompleteResult = ChallengeView & { error?: "wrong_answer" | "not_verified" };

export async function accountRef(projectId: string, accountId: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${projectId}:${accountId}`)));
  return Array.from(d, (x) => x.toString(16).padStart(2, "0")).join("");
}

export async function createChallenge(
  deps: ApiDeps,
  input: { project: Project; decision_id: string; event_type: EventType; rung: Rung; contact_email?: string; account_ref?: string; now: number },
): Promise<Challenge> {
  return deps.store.createChallenge({
    id: `ch_${randomId(18)}`,
    project_id: input.project.id,
    decision_id: input.decision_id,
    event_type: input.event_type,
    rung: input.rung,
    state: "pending",
    attempts: 0,
    sends: 0,
    last_sent_at: null,
    account_ref: input.account_ref ?? null,
    contact_email: input.contact_email ?? null,
    secret: null,
    tried: [],
    expires_at: new Date(input.now + CHALLENGE_TTL_S * 1000),
  });
}

async function write(ctx: ChallengeCtx, ch: Challenge, patch: ChallengePatch): Promise<Challenge> {
  const terminal = patch.state !== undefined && TERMINAL_STATES.has(patch.state);
  // Personal data and secrets live only as long as the challenge is open.
  const full: ChallengePatch = terminal ? { ...patch, contact_email: null, secret: null } : patch;
  const next = await ctx.deps.store.updateChallenge(ch.id, ch.version, full);
  if (!next) throw new ChallengeConflict();
  return next;
}

function rungAvailable(ch: Challenge, rung: Rung): boolean {
  switch (rung) {
    case "email_otp":
      return ch.contact_email !== null;
    case "passkey":
      return ch.account_ref !== null;
    default:
      return true;
  }
}

async function expireIfNeeded(ctx: ChallengeCtx, ch: Challenge): Promise<Challenge> {
  if (!TERMINAL_STATES.has(ch.state) && ctx.now >= ch.expires_at.getTime()) return write(ctx, ch, { state: "expired" });
  return ch;
}

/** Issue (or re-issue) the current rung and return what the browser needs. */
export async function startChallenge(ctx: ChallengeCtx, ch0: Challenge): Promise<ChallengeView> {
  const ch = await expireIfNeeded(ctx, ch0);
  if (TERMINAL_STATES.has(ch.state)) return terminalView(ch);
  return issue(ctx, ch);
}

async function issue(ctx: ChallengeCtx, ch: Challenge): Promise<ChallengeView> {
  const { deps, project, now } = ctx;
  const secrets = deps.tokenSecrets;
  const view = (c: Challenge, payload: RungPayload): ChallengeView => ({
    challenge_id: c.id,
    state: "issued",
    rung: c.rung,
    payload,
    attempts_left: Math.max(0, MAX_ATTEMPTS - c.attempts),
    can_fallback: FALLBACK[c.rung] !== null,
  });

  switch (ch.rung) {
    case "pow": {
      const pow = await issuePowChallenge(secrets[0]!, { bits: CHALLENGE_POW_BITS, now });
      const c = await write(ctx, ch, { state: "issued", secret: { pow_token: pow.token } });
      return view(c, { rung: "pow", salt: pow.salt, bits: pow.bits });
    }

    case "email_otp": {
      if (!ch.contact_email) return moveDown(ctx, ch);
      const sinceLast = ch.last_sent_at ? (now - ch.last_sent_at.getTime()) / 1000 : Infinity;
      const canSend = ch.sends < OTP_MAX_SENDS && sinceLast >= OTP_RESEND_AFTER_S;
      let c = ch;
      if (canSend) {
        const code = generateOtp();
        c = await write(ctx, ch, {
          state: "issued",
          sends: ch.sends + 1,
          last_sent_at: new Date(now),
          secret: { otp_hash: await hashOtp(ch.id, code), otp_exp: now + OTP_TTL_S * 1000 },
        });
        await (deps.emailSender ?? CONSOLE_SENDER).send({ to: ch.contact_email, ...otpEmail(code, project.name) });
      }
      const nextIn = c.sends >= OTP_MAX_SENDS ? -1 : Math.max(0, Math.ceil(OTP_RESEND_AFTER_S - (now - (c.last_sent_at?.getTime() ?? now)) / 1000));
      return view(c, {
        rung: "email_otp",
        sent_to: maskEmail(ch.contact_email),
        code_length: OTP_LENGTH,
        resend_after_s: nextIn,
        expires_in_s: Math.max(0, Math.round((Number(c.secret?.otp_exp ?? now) - now) / 1000)),
        sent: canSend,
      });
    }

    case "passkey": {
      if (!ch.account_ref) return moveDown(ctx, ch);
      const rpID = new URL(ctx.origin).hostname;
      const existing = await deps.store.listPasskeys(project.id, ch.account_ref);
      if (existing.length) {
        const options = await generateAuthenticationOptions({
          rpID,
          allowCredentials: existing.map((p) => ({ id: p.credential_id, transports: p.transports as never })),
          userVerification: "preferred",
        });
        const c = await write(ctx, ch, { state: "issued", secret: { webauthn: options.challenge, mode: "authenticate", origin: ctx.origin } });
        return view(c, { rung: "passkey", mode: "authenticate", options });
      }
      if (ch.event_type !== "signup") return moveDown(ctx, ch);
      const options = await generateRegistrationOptions({
        rpName: project.name,
        rpID,
        userName: `account-${ch.account_ref.slice(0, 8)}`,
        userID: fromBase64url(base64url(hexBytes(ch.account_ref).slice(0, 32))),
        attestationType: "none",
        authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
      });
      const c = await write(ctx, ch, { state: "issued", secret: { webauthn: options.challenge, mode: "register", origin: ctx.origin } });
      return view(c, { rung: "passkey", mode: "register", options });
    }

    case "id_verify": {
      const started = await (deps.idVerifier ?? STUB_ID).start({ challenge_id: ch.id });
      if (started.status !== "started") return moveDown(ctx, ch);
      const c = await write(ctx, ch, { state: "issued", secret: { id_session: started.session_id } });
      return view(c, { rung: "id_verify", url: started.url });
    }

    case "review":
      return enterReview(ctx, ch);
  }
}

async function enterReview(ctx: ChallengeCtx, ch: Challenge): Promise<ChallengeView> {
  const c = await write(ctx, ch, { rung: "review", state: "review", tried: [...ch.tried, ch.rung] });
  await ctx.deps.store.createReviewItem({ project_id: ch.project_id, challenge_id: ch.id, decision_id: ch.decision_id, event_type: ch.event_type });
  return terminalView(c);
}

/** Next rung down the ladder (user asked for another way, the rung is unavailable, or attempts ran out). */
export async function moveDown(ctx: ChallengeCtx, ch0: Challenge): Promise<ChallengeView> {
  const ch = await expireIfNeeded(ctx, ch0);
  if (TERMINAL_STATES.has(ch.state)) return terminalView(ch);
  const rung = nextAvailableRung(ch.rung, (r) => rungAvailable(ch, r) && !ch.tried.includes(r));
  const moved = await write(ctx, ch, { rung, state: "pending", attempts: 0, secret: null, tried: [...ch.tried, ch.rung] });
  return issue(ctx, moved);
}

export async function completeChallenge(ctx: ChallengeCtx, ch0: Challenge, response: unknown): Promise<CompleteResult> {
  const ch = await expireIfNeeded(ctx, ch0);
  if (TERMINAL_STATES.has(ch.state)) return terminalView(ch);
  if (ch.state !== "issued" || !ch.secret) return startChallenge(ctx, ch);

  const ok = await check(ctx, ch, response);
  if (ok) {
    const c = await write(ctx, ch, { state: "passed", tried: [...ch.tried, ch.rung] });
    const data: PassTokenData = { p: c.project_id, d: c.decision_id, c: c.id, e: c.event_type, r: ch.rung };
    const pass_token = await signToken(ctx.deps.tokenSecrets[0]!, PASS_TOKEN_TYPE, data, { ttlSeconds: PASS_TOKEN_TTL_S, now: ctx.now });
    return { challenge_id: c.id, state: "passed", rung: ch.rung, pass_token };
  }

  const attempts = ch.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    const counted = await write(ctx, ch, { attempts });
    return { ...(await moveDown(ctx, counted)), error: "wrong_answer" };
  }
  const c = await write(ctx, ch, { attempts });
  // Passkey options are single-use: re-issue so the next try has a fresh challenge.
  const view = ch.rung === "passkey" ? await issue(ctx, c) : await currentView(ctx, c);
  return { ...view, error: ch.rung === "passkey" ? "not_verified" : "wrong_answer" };
}

/** The issued view without re-sending or re-issuing anything. */
async function currentView(ctx: ChallengeCtx, ch: Challenge): Promise<ChallengeView> {
  const base = { challenge_id: ch.id, state: "issued" as const, rung: ch.rung, attempts_left: MAX_ATTEMPTS - ch.attempts, can_fallback: FALLBACK[ch.rung] !== null };
  if (ch.rung === "email_otp" && ch.contact_email) {
    const since = ch.last_sent_at ? (ctx.now - ch.last_sent_at.getTime()) / 1000 : Infinity;
    return {
      ...base,
      payload: {
        rung: "email_otp",
        sent_to: maskEmail(ch.contact_email),
        code_length: OTP_LENGTH,
        resend_after_s: ch.sends >= OTP_MAX_SENDS ? -1 : Math.max(0, Math.ceil(OTP_RESEND_AFTER_S - since)),
        expires_in_s: Math.max(0, Math.round((Number(ch.secret?.otp_exp ?? ctx.now) - ctx.now) / 1000)),
        sent: false,
      },
    };
  }
  return issue(ctx, ch);
}

async function check(ctx: ChallengeCtx, ch: Challenge, response: unknown): Promise<boolean> {
  const r = (response ?? {}) as Record<string, unknown>;
  const s = ch.secret!;
  switch (ch.rung) {
    case "pow": {
      if (typeof r.nonce !== "string") return false;
      const status = await verifyPow(ctx.deps.tokenSecrets, String(s.pow_token), r.nonce, ctx.deps.replay, { minBits: CHALLENGE_POW_BITS, now: ctx.now });
      return status === "passed";
    }
    case "email_otp": {
      if (typeof r.code !== "string" || !/^\d{6}$/.test(r.code.trim())) return false;
      if (ctx.now > Number(s.otp_exp)) return false;
      return timingSafeEqual(await hashOtp(ch.id, r.code.trim()), String(s.otp_hash));
    }
    case "passkey":
      return checkPasskey(ctx, ch, r.credential);
    default:
      return false;
  }
}

async function checkPasskey(ctx: ChallengeCtx, ch: Challenge, credential: unknown): Promise<boolean> {
  const s = ch.secret!;
  const origin = String(s.origin);
  const rpID = new URL(origin).hostname;
  if (!credential || typeof credential !== "object" || !ch.account_ref) return false;
  try {
    if (s.mode === "register") {
      const v = await verifyRegistrationResponse({
        response: credential as RegistrationResponseJSON,
        expectedChallenge: String(s.webauthn),
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: false,
      });
      if (!v.verified) return false;
      const cred = v.registrationInfo.credential;
      await ctx.deps.store.addPasskey({
        project_id: ch.project_id,
        credential_id: cred.id,
        account_ref: ch.account_ref,
        public_key: base64url(cred.publicKey),
        counter: cred.counter,
        transports: cred.transports ?? [],
      });
      return true;
    }
    const resp = credential as AuthenticationResponseJSON;
    const stored = (await ctx.deps.store.listPasskeys(ch.project_id, ch.account_ref)).find((p) => p.credential_id === resp.id);
    if (!stored) return false;
    const v = await verifyAuthenticationResponse({
      response: resp,
      expectedChallenge: String(s.webauthn),
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: { id: stored.credential_id, publicKey: fromBase64url(stored.public_key), counter: stored.counter, transports: stored.transports as never },
      requireUserVerification: false,
    });
    if (!v.verified) return false;
    await ctx.deps.store.updatePasskeyCounter(ch.project_id, stored.credential_id, v.authenticationInfo.newCounter);
    return true;
  } catch {
    return false;
  }
}

function terminalView(ch: Challenge): ChallengeView {
  if (ch.state === "review") {
    return {
      challenge_id: ch.id,
      state: "review",
      rung: "review",
      payload: { rung: "review", message: "A member of the team will review this and email you." },
    };
  }
  if (ch.state === "passed") return { challenge_id: ch.id, state: "used", rung: ch.rung };
  return { challenge_id: ch.id, state: ch.state as "failed" | "expired", rung: ch.rung };
}

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
