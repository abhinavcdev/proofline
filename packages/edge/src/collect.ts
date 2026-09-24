import { EdgeSignals, type Mode } from "@proofline/core";
import { classifyAsn } from "./asn.js";
import { headerAnomalies, headerFingerprint, uaFamily } from "./headers.js";
import { EMPTY_IP_LIST, hashIp, normalizeIp, type IpReputation } from "./ip.js";
import { HARD_RATE_LIMITS, type RateCounter } from "./rate.js";
import type { WebBotAuthVerifier } from "./webbotauth.js";

/** What the platform tells us about a request. Adapters fill this in. */
export interface EdgeContext {
  request: Request;
  ip?: string | undefined;
  asn?: number | undefined;
  asOrganization?: string | undefined;
  country?: string | undefined;
  ja4?: string | undefined;
  httpProtocol?: string | undefined;
  /** Platform-verified crawler (Cloudflare `verifiedBot`). */
  verifiedBot?: boolean | undefined;
  /** Header names in wire order, when the platform exposes them. */
  rawHeaderNames?: readonly string[] | undefined;
  /**
   * True when `request` is the end user's own request (browser → /v1/signals or
   * edge middleware). False when headers were forwarded by a customer server.
   */
  direct: boolean;
}

export interface EdgeDeps {
  /** IP_SALT_SECRET. */
  saltSecret: string;
  rate: RateCounter;
  ipReputation?: IpReputation | undefined;
  agents?: WebBotAuthVerifier | undefined;
  now?: () => number;
}

export type RateLimitedOn = "ip" | "asn" | "fingerprint";

export interface EdgeResult {
  signals: EdgeSignals;
  /** Hard rate limits exceeded (deterministic block). */
  rate_limited: RateLimitedOn[];
}

export async function collectEdgeSignals(ctx: EdgeContext, deps: EdgeDeps): Promise<EdgeResult> {
  const now = deps.now?.() ?? Date.now();
  const { headers } = ctx.request;
  const ip = ctx.ip ? normalizeIp(ctx.ip) : null;

  const [ipHash, headerFp, agent, knownBad] = await Promise.all([
    hashIp(ip ?? "unknown", deps.saltSecret, now),
    headerFingerprint(headers, ctx.rawHeaderNames),
    deps.agents && ctx.direct ? deps.agents.verify(ctx.request) : Promise.resolve({ status: "none" as const }),
    ip ? (deps.ipReputation ?? EMPTY_IP_LIST).isBad(ip) : Promise.resolve(false),
  ]);

  // Verified agents get their own rate budget, so a polite agent can't be
  // throttled by (or hide inside) human traffic from the same network.
  const lane = ctx.verifiedBot || agent.status === "verified" ? "agent:" : "";
  const keys = [
    ...(ip ? [`${lane}ip:${ipHash}`] : []),
    ...(ctx.asn !== undefined ? [`${lane}asn:${ctx.asn}`] : []),
    `${lane}fp:${headerFp}`,
  ];
  const counts = await deps.rate.hit(keys, now);
  let i = 0;
  const ip1m = ip ? counts[i++]! : 0;
  const asn1m = ctx.asn !== undefined ? counts[i++]! : 0;
  const fp1m = counts[i]!;

  const rate_limited: RateLimitedOn[] = [];
  if (ip1m > HARD_RATE_LIMITS.ip) rate_limited.push("ip");
  if (asn1m > HARD_RATE_LIMITS.asn) rate_limited.push("asn");
  if (fp1m > HARD_RATE_LIMITS.fingerprint) rate_limited.push("fingerprint");

  const declared =
    agent.status === "verified"
      ? { status: "verified" as const, name: agent.name }
      : ctx.verifiedBot
        ? { status: "verified" as const, name: `verified_bot:${uaFamily(headers.get("user-agent"))}` }
        : agent.status === "unverified_claim"
          ? { status: "unverified_claim" as const }
          : { status: "none" as const };

  const country = ctx.country?.toUpperCase();
  const signals = EdgeSignals.parse({
    ip_hash: ipHash,
    ...(ctx.asn !== undefined ? { asn: ctx.asn } : {}),
    asn_class: classifyAsn(ctx.asn, ctx.asOrganization),
    ...(country && /^[A-Z]{2}$/.test(country) && country !== "XX" && country !== "T1" ? { country } : {}),
    ...(ctx.ja4 ? { ja4: ctx.ja4.slice(0, 64) } : {}),
    header_fp: headerFp,
    header_anomalies: headerAnomalies({ headers, httpProtocol: ctx.httpProtocol, direct: ctx.direct }),
    ua_family: uaFamily(headers.get("user-agent")),
    rate: { ip_1m: ip1m, asn_1m: asn1m, fp_1m: fp1m },
    declared_agent: declared,
    known_bad_ip: knownBad,
  });
  return { signals, rate_limited };
}

export interface EdgeGuardResult extends EdgeResult {
  /** Set in enforce mode when a deterministic check fails. Return it as-is. */
  response?: Response;
}

/**
 * Edge middleware core. `shadow` only annotates. `enforce` short-circuits
 * requests that fail deterministic checks (known-bad IP, hard rate limit) with
 * a 403. Model-based decisions still go through /v1/assess.
 */
export function createEdgeGuard(opts: { mode: Mode; deps: EdgeDeps }) {
  return async (ctx: EdgeContext): Promise<EdgeGuardResult> => {
    const r = await collectEdgeSignals(ctx, opts.deps);
    const hardFail = r.signals.known_bad_ip || r.rate_limited.length > 0;
    if (opts.mode === "enforce" && hardFail) {
      return {
        ...r,
        response: new Response(JSON.stringify({ error: { code: "forbidden", message: "Request blocked" } }), {
          status: 403,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        }),
      };
    }
    return r;
  };
}
