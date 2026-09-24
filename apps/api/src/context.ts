import type { Context } from "hono";
import { cloudflareContext, genericContext, type EdgeContext } from "@proofline/edge";
import type { ApiDeps } from "./deps.js";

/** Edge context for the incoming request: custom resolver, Cloudflare `cf`, or headers only. */
export function edgeContextFor(c: Context, deps: ApiDeps, opts: { direct: boolean }): EdgeContext {
  if (deps.edgeContext) return { ...deps.edgeContext(c), direct: opts.direct };
  const raw = c.req.raw as Request & { cf?: unknown };
  if (raw.cf) return cloudflareContext(raw, opts.direct);
  return genericContext(raw, { direct: opts.direct });
}
