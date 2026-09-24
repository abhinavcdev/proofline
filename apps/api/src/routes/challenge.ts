import { Hono, type Context } from "hono";
import { z } from "zod";
import { PASS_TOKEN_TYPE, verifyToken, type PassTokenData } from "@proofline/core";
import type { ApiDeps, AppEnv } from "../deps.js";
import { apiError } from "../errors.js";
import { authenticate, bearer, requireKey } from "../middleware/apiKey.js";
import { ChallengeConflict, completeChallenge, moveDown, startChallenge, type ChallengeCtx } from "../challenge/service.js";
import { checkOrigin, readJson } from "./signals.js";

const ChallengeId = z.string().regex(/^ch_[A-Za-z0-9_-]{16,40}$/, "must be a challenge id");
const StartBody = z.object({ key: z.string().max(128).optional(), challenge_id: ChallengeId });
const CompleteBody = StartBody.extend({
  response: z.union([
    z.object({ nonce: z.string().max(32) }),
    z.object({ code: z.string().max(12) }),
    // WebAuthn JSON (registration or assertion); SimpleWebAuthn validates the shape.
    z.object({ credential: z.record(z.string(), z.unknown()) }),
  ]),
});
const VerifyBody = z.object({ pass_token: z.string().max(4096) });

/**
 * Browser-facing challenge routes (publishable key, origin allowlist) plus
 * `/challenge/verify` for the customer's server (secret key).
 */
export function challengeRoutes(deps: ApiDeps) {
  const app = new Hono<AppEnv>();
  const now = deps.now ?? Date.now;

  async function load(c: Context<AppEnv>, schema: typeof StartBody | typeof CompleteBody) {
    const parsed = await readJson(c, schema);
    if (!parsed.ok) return { res: parsed.res };
    const denied = await authenticate(c, deps, parsed.data.key ?? bearer(c), "publishable");
    if (denied) return { res: denied };
    const project = c.get("project");
    const origin = checkOrigin(c, project.allowed_origins);
    if (origin === null || origin === "*") return { res: apiError(c, 403, "forbidden", "Origin not allowed for this project") };
    const ch = await deps.store.getChallenge(project.id, parsed.data.challenge_id);
    if (!ch) return { res: apiError(c, 404, "not_found", "Unknown challenge") };
    const ctx: ChallengeCtx = { deps, project, origin, now: now() };
    return { ch, ctx, body: parsed.data };
  }

  const run = async (c: Context<AppEnv>, fn: () => Promise<unknown>) => {
    try {
      return c.json(await fn());
    } catch (err) {
      if (err instanceof ChallengeConflict) return apiError(c, 409, "bad_request", "The challenge changed; try again");
      throw err;
    }
  };

  app.post("/challenge/start", async (c) => {
    const l = await load(c, StartBody);
    if ("res" in l) return l.res;
    return run(c, () => startChallenge(l.ctx, l.ch));
  });

  app.post("/challenge/complete", async (c) => {
    const l = await load(c, CompleteBody);
    if ("res" in l) return l.res;
    const body = l.body as z.infer<typeof CompleteBody>;
    return run(c, () => completeChallenge(l.ctx, l.ch, body.response));
  });

  /** "Use another way": the user can't complete this rung (no device, no access to email, …). */
  app.post("/challenge/fallback", async (c) => {
    const l = await load(c, StartBody);
    if ("res" in l) return l.res;
    return run(c, () => moveDown(l.ctx, l.ch));
  });

  /** Server-side check of a pass token. One-time: a second verify returns `replayed`. */
  app.post("/challenge/verify", requireKey(deps, "secret"), async (c) => {
    const parsed = await readJson(c, VerifyBody);
    if (!parsed.ok) return parsed.res;
    const project = c.get("project");
    const v = await verifyToken<PassTokenData>(deps.tokenSecrets, parsed.data.pass_token, PASS_TOKEN_TYPE, now());
    if (!v.ok) return c.json({ valid: false, reason: v.reason === "expired" ? "expired" : "invalid" });
    if (v.claims.data.p !== project.id) return c.json({ valid: false, reason: "invalid" });
    if (!(await deps.replay.consume(v.claims.jti, v.claims.exp))) return c.json({ valid: false, reason: "replayed" });
    const d = v.claims.data;
    return c.json({ valid: true, decision_id: d.d, challenge_id: d.c, event_type: d.e, rung: d.r });
  });

  return app;
}
