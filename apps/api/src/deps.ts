import type { Context } from "hono";
import type { DecisionProvider, EmailSender, IdVerifier, ReplayGuard } from "@proofline/core";
import type { ApiKeyRecord, Project, Store } from "@proofline/db";
import type { EdgeContext, IpReputation, RateCounter, WebBotAuthVerifier } from "@proofline/edge";

export interface Logger {
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface ApiDeps {
  store: Store;
  /** Edge counters (per IP, ASN, fingerprint) and per-key API limits. */
  rate: RateCounter;
  /** One-time use for signal-token and PoW ids. */
  replay: ReplayGuard;
  /** TOKEN_SIGNING_SECRET first, then any previous secrets still accepted. */
  tokenSecrets: readonly string[];
  /** IP_SALT_SECRET. */
  ipSaltSecret: string;
  provider: DecisionProvider;
  /** Defaults to RulesOnlyProvider. */
  fallback?: DecisionProvider;
  ipReputation?: IpReputation;
  agents?: WebBotAuthVerifier;
  /** Platform details for the incoming request. Defaults to Cloudflare's `request.cf` when present. */
  edgeContext?: (c: Context) => EdgeContext;
  /** Requests per minute per API key. */
  keyRateLimit?: { publishable: number; secret: number };
  /** Sends one-time codes. Defaults to the console sender (development only). */
  emailSender?: EmailSender;
  /** Defaults to the stub that always reports `unavailable`. */
  idVerifier?: IdVerifier;
  logger?: Logger;
  now?: () => number;
  /** Where background work (decision logging) runs; Workers use executionCtx.waitUntil. */
  waitUntil?: (c: Context, p: Promise<unknown>) => void;
}

export type Timings = Record<string, number>;

export interface AppEnv {
  Variables: {
    project: Project;
    apiKey: ApiKeyRecord;
    timings: Timings;
  };
}
