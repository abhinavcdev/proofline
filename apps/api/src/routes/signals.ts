import { Hono, type Context } from "hono";
import { z } from "zod";
import { BrowserSignals, EventType, issuePowChallenge, signToken, verifyPow } from "@proofline/core";
import { collectEdgeSignals } from "@proofline/edge";
import type { ApiDeps, AppEnv } from "../deps.js";
import { apiError, zodMessage } from "../errors.js";
import { authenticate, bearer } from "../middleware/apiKey.js";
import { timed } from "../middleware/timing.js";
import { SIGNAL_TOKEN_TTL_S, SIGNAL_TOKEN_TYPE, type SignalTokenData } from "../tokens.js";
import { edgeContextFor } from "../context.js";

const MAX_BODY = 16_384;

const SignalsBody = z.object({
  /** Publishable key. Sent in the body so the browser can use a `text/plain` request with no CORS preflight. */
  key: z.string().max(128).optional(),
  event_type: EventType,
  signals: BrowserSignals,
  pow: z.object({ token: z.string().max(2048), nonce: z.string().max(32) }).optional(),
});

const PowBody = z.object({ key: z.string().max(128).optional() });

/**
 * Browser-facing routes (publishable key). Bodies may be `text/plain` JSON:
 * that keeps them "simple" CORS requests, so the 300 ms token budget isn't spent on a preflight.
 */
export function signalsRoutes(deps: ApiDeps) {
  const app = new Hono<AppEnv>();
  const now = deps.now ?? Date.now;
  const perf = () => performance.now();

  app.options("/*", (c) => {
    const origin = c.req.header("origin");
    if (origin) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Vary", "Origin");
    }
    c.header("Access-Control-Allow-Methods", "POST");
    c.header("Access-Control-Allow-Headers", "content-type, authorization");
    c.header("Access-Control-Max-Age", "86400");
    return c.body(null, 204);
  });

  app.post("/signals", async (c) => {
    const parsed = await readJson(c, SignalsBody);
    if (!parsed.ok) return parsed.res;
    const body = parsed.data;

    const denied = await authenticate(c, deps, body.key ?? bearer(c), "publishable");
    if (denied) return denied;
    const project = c.get("project");
    const origin = checkOrigin(c, project.allowed_origins);
    if (origin === null) return apiError(c, 403, "forbidden", "Origin not allowed for this project");

    const edge = await timed(c, "edge", perf, () =>
      collectEdgeSignals(edgeContextFor(c, deps, { direct: true }), {
        saltSecret: deps.ipSaltSecret,
        rate: deps.rate,
        ipReputation: deps.ipReputation,
        agents: deps.agents,
        now,
      }),
    );

    const pw = await timed(c, "pow", perf, () =>
      project.pow_bits
        ? verifyPow(deps.tokenSecrets, body.pow?.token, body.pow?.nonce, deps.replay, { minBits: project.pow_bits, now: now() })
        : Promise.resolve("absent" as const),
    );

    // Without consent, the SDK drops per-field detail; enforce that server-side too.
    const { fields, ...withoutFields } = body.signals;
    const b: BrowserSignals = body.signals.consent && fields ? { ...withoutFields, fields } : withoutFields;

    const data: SignalTokenData = { p: project.id, e: body.event_type, o: origin, b, g: edge.signals, rl: edge.rate_limited, pw };
    const token = await signToken(deps.tokenSecrets[0]!, SIGNAL_TOKEN_TYPE, data, { ttlSeconds: SIGNAL_TOKEN_TTL_S, now: now() });
    return c.json({ token, expires_in: SIGNAL_TOKEN_TTL_S });
  });

  app.post("/pow", async (c) => {
    const parsed = await readJson(c, PowBody);
    if (!parsed.ok) return parsed.res;
    const denied = await authenticate(c, deps, parsed.data.key ?? bearer(c), "publishable");
    if (denied) return denied;
    const project = c.get("project");
    if (checkOrigin(c, project.allowed_origins) === null) return apiError(c, 403, "forbidden", "Origin not allowed for this project");
    if (!project.pow_bits) return c.json({ enabled: false });
    const ch = await issuePowChallenge(deps.tokenSecrets[0]!, { bits: project.pow_bits, now: now() });
    return c.json({ enabled: true, ...ch });
  });

  return app;
}

/** Returns the allowed origin (and sets CORS headers), or null if not allowed. */
export function checkOrigin(c: Context, allowed: readonly string[]): string | null {
  const origin = c.req.header("origin");
  const ok = allowed.includes("*") || (origin !== undefined && allowed.includes(origin));
  if (!ok) return null;
  if (origin) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Vary", "Origin");
  }
  return origin ?? "*";
}

export async function readJson<T>(
  c: Context,
  schema: z.ZodType<T>,
): Promise<{ ok: true; data: T } | { ok: false; res: Response }> {
  const declared = Number(c.req.header("content-length") ?? 0);
  if (declared > MAX_BODY) return { ok: false, res: apiError(c, 413, "payload_too_large", "Body too large") };
  const text = await c.req.text();
  if (text.length > MAX_BODY) return { ok: false, res: apiError(c, 413, "payload_too_large", "Body too large") };
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    return { ok: false, res: apiError(c, 400, "bad_request", "Body must be JSON") };
  }
  const r = schema.safeParse(json);
  if (!r.success) return { ok: false, res: apiError(c, 400, "bad_request", zodMessage(r.error.issues)) };
  return { ok: true, data: r.data };
}
