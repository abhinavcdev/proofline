import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { DrizzleStore } from "@proofline/db";
import { StaticIpList, WebBotAuthVerifier, type TrustedAgent } from "@proofline/edge";
import { createApp } from "../app.js";
import { selectProvider, type ProviderEnv } from "../providers.js";
import { DurableRateCounter, DurableReplayGuard, type RateLimiterDO } from "./durable.js";

export { RateLimiterDO } from "./durable.js";

export interface Env extends ProviderEnv {
  HYPERDRIVE: Hyperdrive;
  RATE_LIMITER: DurableObjectNamespace<RateLimiterDO>;
  TOKEN_SIGNING_SECRET: string;
  /** Comma-separated previous secrets, still accepted during rotation. */
  TOKEN_SIGNING_SECRET_PREVIOUS?: string;
  IP_SALT_SECRET: string;
  /** JSON array of { name, directory } for Web Bot Auth. */
  TRUSTED_AGENTS?: string;
  /** Comma-separated CIDRs. */
  BAD_IP_CIDRS?: string;
}

const logger = {
  warn: (msg: string, data?: Record<string, unknown>) => console.warn(msg, data ?? {}),
  error: (msg: string, data?: Record<string, unknown>) => console.error(msg, data ?? {}),
};

// Per-isolate: pure configuration, no I/O objects (those can't cross requests).
let isolate: { key: string; provider: ReturnType<typeof selectProvider>; agents: WebBotAuthVerifier; bad: StaticIpList } | undefined;

function isolateDeps(env: Env) {
  const key = [env.DECISION_PROVIDER, env.TYPESAFE_API_KEY?.length, env.JEV_MODEL, env.TRUSTED_AGENTS, env.BAD_IP_CIDRS].join("|");
  if (!isolate || isolate.key !== key) {
    const trusted = env.TRUSTED_AGENTS ? (JSON.parse(env.TRUSTED_AGENTS) as TrustedAgent[]) : [];
    isolate = {
      key,
      provider: selectProvider(env),
      agents: new WebBotAuthVerifier({ trusted }),
      bad: new StaticIpList(env.BAD_IP_CIDRS ? env.BAD_IP_CIDRS.split(",").map((s) => s.trim()).filter(Boolean) : []),
    };
  }
  return isolate;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { provider, agents, bad } = isolateDeps(env);
    // Hyperdrive pools connections; a client per request is the recommended pattern.
    const sql = postgres(env.HYPERDRIVE.connectionString, { max: 5, fetch_types: false, prepare: false });
    const pending: Promise<unknown>[] = [];
    const app = createApp({
      store: new DrizzleStore(drizzle(sql)),
      rate: new DurableRateCounter(env.RATE_LIMITER),
      replay: new DurableReplayGuard(env.RATE_LIMITER),
      tokenSecrets: [env.TOKEN_SIGNING_SECRET, ...(env.TOKEN_SIGNING_SECRET_PREVIOUS?.split(",").filter(Boolean) ?? [])],
      ipSaltSecret: env.IP_SALT_SECRET,
      provider,
      agents,
      ipReputation: bad,
      logger,
      waitUntil: (_c, p) => pending.push(p),
    });
    const res = await app.fetch(request, env, ctx);
    ctx.waitUntil(Promise.allSettled(pending).then(() => sql.end()));
    return res;
  },
};
