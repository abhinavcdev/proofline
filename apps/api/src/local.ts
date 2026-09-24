import { serve, type ServerType } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { ConsoleEmailSender, MemoryReplayGuard, ResendEmailSender } from "@proofline/core";
import type { Store } from "@proofline/db";
import { createPgliteStore, createPostgresStore } from "@proofline/db/node";
import { MemoryRateCounter, StaticIpList, genericContext } from "@proofline/edge";
import { createApp } from "./app.js";
import type { ApiDeps } from "./deps.js";
import { selectProvider } from "./providers.js";

/**
 * Node server for local development and tests: PGlite (or DATABASE_URL),
 * in-memory counters. The IP comes from the socket, or from X-Forwarded-For
 * when TRUST_PROXY=1.
 */

const DEV_TOKEN_SECRET = "dev-only-token-secret-do-not-use-in-prod-0001";
const DEV_SALT_SECRET = "dev-only-ip-salt-secret-do-not-use-in-prod-001";

export interface LocalApiOptions {
  port?: number;
  store?: Store;
  env?: Record<string, string | undefined>;
  deps?: Partial<ApiDeps>;
}

export interface LocalApi {
  url: string;
  store: Store;
  server: ServerType;
  close(): Promise<void>;
}

export async function startLocalApi(opts: LocalApiOptions = {}): Promise<LocalApi> {
  const env = opts.env ?? process.env;
  let store = opts.store;
  let closeStore = async () => {};
  if (!store) {
    const s = env.DATABASE_URL ? await createPostgresStore(env.DATABASE_URL, { migrate: true }) : await createPgliteStore(env.PGLITE_DIR);
    store = s.store;
    closeStore = s.close;
  }
  const trustProxy = env.TRUST_PROXY === "1";
  const app = createApp({
    store,
    rate: new MemoryRateCounter(),
    replay: new MemoryReplayGuard(),
    tokenSecrets: [env.TOKEN_SIGNING_SECRET ?? DEV_TOKEN_SECRET],
    ipSaltSecret: env.IP_SALT_SECRET ?? DEV_SALT_SECRET,
    provider: selectProvider(env),
    emailSender: env.RESEND_API_KEY
      ? new ResendEmailSender(env.RESEND_API_KEY, env.EMAIL_FROM ?? "Proofline <verify@proofline.dev>")
      : new ConsoleEmailSender(),
    ipReputation: new StaticIpList(env.BAD_IP_CIDRS?.split(",").map((s) => s.trim()).filter(Boolean) ?? []),
    edgeContext: (c) => {
      const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string }; rawHeaders?: string[] } } | undefined)?.incoming;
      const forwarded = trustProxy ? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() : undefined;
      const raw = incoming?.rawHeaders?.filter((_, i) => i % 2 === 0);
      return genericContext(c.req.raw, { ip: forwarded ?? incoming?.socket?.remoteAddress, direct: true, ...(raw ? { rawHeaderNames: raw } : {}) });
    },
    logger: { warn: (m, d) => console.warn(m, d ?? {}), error: (m, d) => console.error(m, d ?? {}) },
    ...opts.deps,
  });

  const server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: app.fetch, port: opts.port ?? Number(env.PORT ?? 8787) }, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://localhost:${port}`,
    store,
    server,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await closeStore();
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const api = await startLocalApi();
  console.warn(`Proofline API listening on ${api.url}`);
}
