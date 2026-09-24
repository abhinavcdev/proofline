import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import type { Store } from "@proofline/db";
import { createProofline } from "@proofline/sdk-server";
import { createDemoApp } from "./app.js";
import { sdkBundle } from "./sdk.js";

/**
 * Local demo. With no configuration it starts a Proofline API in-process
 * (PGlite, mock decisions), creates a shadow-mode project for this origin,
 * and prints the keys. To use an existing API instead, set
 * PROOFLINE_API_URL, PROOFLINE_SECRET_KEY and PROOFLINE_PUBLISHABLE_KEY.
 */

export async function startDemo(opts: { port?: number; apiPort?: number; mode?: "shadow" | "enforce" } = {}) {
  const port = opts.port ?? Number(process.env.PORT ?? 3000);
  let apiUrl = process.env.PROOFLINE_API_URL;
  let secretKey = process.env.PROOFLINE_SECRET_KEY;
  let publishableKey = process.env.PROOFLINE_PUBLISHABLE_KEY;
  let closeApi = async () => {};
  let store: Store | undefined;
  let projectId: string | undefined;
  let handler: (req: Request, env: unknown) => Response | Promise<Response> = () => new Response("Starting…", { status: 503 });

  const demoServer = await new Promise<ReturnType<typeof serve>>((resolve) => {
    // Bind first so the origin (and its port) is known before the project is created.
    const s = serve({ fetch: (req, env) => handler(req, env), port }, () => resolve(s));
  });
  const origin = `http://localhost:${(demoServer.address() as AddressInfo).port}`;

  if (!apiUrl || !secretKey || !publishableKey) {
    const { startLocalApi } = await import("@proofline/api/local");
    const api = await startLocalApi({ port: opts.apiPort ?? Number(process.env.API_PORT ?? 8787) });
    const project = await api.store.createProject({ name: "Crumb & Co. Bakery", allowed_origins: [origin], mode: opts.mode ?? "shadow" });
    secretKey = (await api.store.createApiKey(project.id, "secret")).key;
    publishableKey = (await api.store.createApiKey(project.id, "publishable")).key;
    apiUrl = api.url;
    closeApi = api.close;
    store = api.store;
    projectId = project.id;
  }

  const demo = createDemoApp({
    proofline: createProofline({ secretKey, baseUrl: apiUrl, onError: (e) => console.warn(`[proofline] ${e.kind}: ${e.message}`) }),
    publishableKey,
    apiUrl,
    sdkScript: sdkBundle,
    remoteAddress: (_req, env) => (env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress,
  });
  handler = (req, env) => demo.app.fetch(req, env);

  return {
    url: origin,
    apiUrl,
    submissions: demo.submissions,
    /** Only when the API runs in-process. */
    store,
    projectId,
    close: async () => {
      await new Promise<void>((r) => demoServer.close(() => r()));
      await closeApi();
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const d = await startDemo();
  console.warn(`Crumb & Co. Bakery: ${d.url}  (Proofline API: ${d.apiUrl}, shadow mode)`);
}
