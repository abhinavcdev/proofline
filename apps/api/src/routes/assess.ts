import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  EventType,
  RulesOnlyProvider,
  ServerContext,
  buildState,
  decide,
  defaultPolicy,
  redact,
  rungOf,
  verifyToken,
  type Answers,
  type Capabilities,
  type DeterministicChecks,
  type EdgeSignals,
  type TokenStatus,
} from "@proofline/core";
import { uuidv7, type DecisionEventRecord } from "@proofline/db";
import { collectEdgeSignals, genericContext, type RateLimitedOn } from "@proofline/edge";
import { getQuestionSet } from "@proofline/questions";
import type { ApiDeps, AppEnv } from "../deps.js";
import { requireKey } from "../middleware/apiKey.js";
import { timed } from "../middleware/timing.js";
import { SIGNAL_TOKEN_TYPE, SignalTokenData } from "../tokens.js";
import { readJson } from "./signals.js";

const AssessBody = z.object({
  event_type: EventType,
  /** The `proofline_token` form field, if the browser SDK produced one. */
  signal_token: z.string().max(8192).optional(),
  context: ServerContext.optional(),
  /**
   * The end user's connection as seen by the customer's server. Used for
   * network signals when there is no valid signal token (for example a bot
   * posting straight to the form). The IP is hashed immediately and never stored.
   */
  client: z
    .object({
      ip: z.string().max(64).optional(),
      user_agent: z.string().max(512).optional(),
      accept_language: z.string().max(256).optional(),
    })
    .optional(),
});

const fallback = new RulesOnlyProvider();

export function assessRoutes(deps: ApiDeps) {
  const app = new Hono<AppEnv>();
  const now = deps.now ?? Date.now;
  const perf = () => performance.now();

  app.post("/assess", requireKey(deps, "secret"), async (c) => {
    const t0 = perf();
    const parsed = await readJson(c, AssessBody);
    if (!parsed.ok) return parsed.res;
    const body = parsed.data;
    const project = c.get("project");

    // 1. Verify the signal token (signature, expiry, binding, one-time use).
    const token = await timed(c, "verify", perf, () => verifySignalToken(deps, body.signal_token, project.id, body.event_type, now()));

    // 2. Network signals: from the token, else from the forwarded client details.
    const edge = await timed(c, "edge", perf, async (): Promise<{ signals?: EdgeSignals; rate_limited: RateLimitedOn[] }> => {
      if (token.data) return { signals: token.data.g, rate_limited: token.data.rl };
      if (!body.client) return { rate_limited: [] };
      const headers = new Headers();
      if (body.client.user_agent) headers.set("user-agent", body.client.user_agent);
      if (body.client.accept_language) headers.set("accept-language", body.client.accept_language);
      const req = new Request("https://client.invalid/", { headers });
      return collectEdgeSignals(genericContext(req, { ip: body.client.ip, direct: false }), {
        saltSecret: deps.ipSaltSecret,
        rate: deps.rate,
        ipReputation: deps.ipReputation,
        now,
      });
    });

    const checks: DeterministicChecks = {
      token: token.status,
      pow: token.data?.pw ?? "absent",
      rate_limited: edge.rate_limited,
      known_bad_ip: edge.signals?.known_bad_ip ?? false,
      declared_agent: edge.signals?.declared_agent.status ?? "none",
    };

    // 3. Compact state.
    const state = await timed(c, "state", perf, () =>
      buildState({
        event: body.event_type,
        token: token.status,
        browser: token.data?.b,
        edge: edge.signals,
        server: body.context,
        pow: checks.pow,
      }),
    );

    // 4–5. Model (with fallback) → policy → mode.
    const policy = (await deps.store.getPolicy(project.id, body.event_type)) ?? defaultPolicy(body.event_type);
    const capabilities: Capabilities = {
      passkey: body.context?.account?.has_passkey ?? false,
      email: body.context?.account?.has_verified_email ?? false,
      id_verify: false,
    };
    const out = await decide({
      state,
      checks,
      policy,
      capabilities,
      mode: project.mode,
      questions: getQuestionSet(project.questions_version),
      provider: deps.provider,
      fallback: deps.fallback ?? fallback,
      timeoutMs: project.jev_timeout_ms,
      now: perf,
    });
    const timings = c.get("timings");
    timings.decide = out.timings.decide_ms;
    timings.policy = out.timings.policy_ms;

    const id = uuidv7(now());
    const d = out.decision;
    const rung = rungOf(d.action);

    // 6. Log off the hot path.
    const record: DecisionEventRecord = {
      id,
      ts: new Date(now()),
      project_id: project.id,
      event_type: body.event_type,
      action: d.action,
      effective_action: d.effective_action,
      mode: d.mode,
      ...(rung ? { rung } : {}),
      risk: d.risk,
      matched: d.matched,
      decision_source: out.source,
      ...(out.fallback_reason ? { fallback_reason: out.fallback_reason } : {}),
      questions_version: out.questions_version,
      policy_version: out.policy_version,
      token_status: token.status,
      ...flattenAnswers(out.answers),
      answers: out.answers,
      reasons: d.reasons,
      state,
      ...(edge.signals
        ? {
            ip_hash: edge.signals.ip_hash,
            ...(edge.signals.asn !== undefined ? { asn: edge.signals.asn } : {}),
            ...(edge.signals.country ? { country: edge.signals.country } : {}),
            ...(edge.signals.ja4 ? { ja4: edge.signals.ja4 } : {}),
            ua_family: edge.signals.ua_family,
            declared_agent: edge.signals.declared_agent.name ?? edge.signals.declared_agent.status,
          }
        : {}),
      t_total_ms: 0,
      ...(timings.verify !== undefined ? { t_verify_ms: timings.verify } : {}),
      ...(timings.edge !== undefined ? { t_edge_ms: timings.edge } : {}),
      ...(timings.state !== undefined ? { t_state_ms: timings.state } : {}),
      t_decide_ms: out.timings.decide_ms,
      t_policy_ms: out.timings.policy_ms,
    };
    record.t_total_ms = Math.round((perf() - t0) * 10) / 10;
    background(c, deps, deps.store.insertDecision(record));

    return c.json({
      decision_id: id,
      action: d.effective_action,
      mode: d.mode,
      ...(d.mode === "shadow" ? { would_have: d.action } : {}),
      risk: d.risk,
      reasons: d.reasons,
      ...(out.source === "fallback" ? { degraded: true } : {}),
    });
  });

  return app;
}

async function verifySignalToken(
  deps: ApiDeps,
  token: string | undefined,
  projectId: string,
  eventType: EventType,
  nowMs: number,
): Promise<{ status: TokenStatus; data?: SignalTokenData }> {
  if (!token) return { status: "missing" };
  const v = await verifyToken<unknown>(deps.tokenSecrets, token, SIGNAL_TOKEN_TYPE, nowMs);
  if (!v.ok) return { status: v.reason === "expired" ? "expired" : "invalid" };
  const data = SignalTokenData.safeParse(v.claims.data);
  // A token minted for another project or event type is treated as forged.
  if (!data.success || data.data.p !== projectId || data.data.e !== eventType) return { status: "invalid" };
  if (!(await deps.replay.consume(v.claims.jti, v.claims.exp))) return { status: "replayed" };
  return { status: "valid", data: data.data };
}

function flattenAnswers(a: Answers): Partial<DecisionEventRecord> {
  const out: Partial<DecisionEventRecord> = {};
  const auto = a.is_automated;
  if (auto?.type === "noul") out.p_automated = auto.p;
  const actor = a.actor_type;
  if (actor?.type === "choice") {
    out.actor_type = actor.label;
    out.actor_conf = actor.confidence;
  }
  const risk = a.risk_level;
  if (risk?.type === "score") {
    out.risk_level = risk.value;
    out.risk_conf = risk.confidence;
  }
  const intent = a.intent;
  if (intent?.type === "choice") out.intent = intent.label;
  const tpl = a.content_is_templated;
  if (tpl?.type === "noul") out.p_templated = tpl.p;
  return out;
}

function background(c: Context, deps: ApiDeps, p: Promise<unknown>) {
  const logged = p.catch((err: unknown) => deps.logger?.error("decision log failed", redact({ error: String(err) })));
  if (deps.waitUntil) return deps.waitUntil(c, logged);
  try {
    c.executionCtx.waitUntil(logged);
  } catch {
    // No execution context (Node): the promise runs on its own.
  }
}
