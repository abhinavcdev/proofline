import type { Context, MiddlewareHandler } from "hono";
import { maskSecret } from "@proofline/core";
import { hashApiKey, scopeOfKey, type KeyScope } from "@proofline/db";
import type { ApiDeps, AppEnv } from "../deps.js";
import { apiError } from "../errors.js";

const DEFAULT_LIMITS = { publishable: 600, secret: 1200 };

/** Bearer token, or (publishable keys only) a `key` field the route read from the body. */
export function bearer(c: Context): string | undefined {
  const h = c.req.header("authorization");
  return h?.startsWith("Bearer ") ? h.slice(7).trim() : undefined;
}

/**
 * Resolves the key to a project and enforces scope and per-key rate limits.
 * Keys are looked up by sha256 and never logged beyond their public prefix.
 */
export async function authenticate(
  c: Context<AppEnv>,
  deps: ApiDeps,
  key: string | undefined,
  scope: KeyScope,
): Promise<Response | null> {
  if (!key) return apiError(c, 401, "unauthorized", "Missing API key");
  const keyScope = scopeOfKey(key);
  if (!keyScope) return apiError(c, 401, "unauthorized", "Malformed API key");
  if (keyScope !== scope) {
    return apiError(c, 403, "forbidden", `This endpoint needs a ${scope} key (got ${maskSecret(key)})`);
  }
  const found = await deps.store.findApiKeyByHash(await hashApiKey(key));
  if (!found) return apiError(c, 401, "unauthorized", "Unknown or revoked API key");

  const limit = (deps.keyRateLimit ?? DEFAULT_LIMITS)[scope];
  const [count] = await deps.rate.hit([`key:${found.key.id}`]);
  if ((count ?? 0) > limit) {
    c.header("Retry-After", "60");
    return apiError(c, 429, "rate_limited", "Too many requests for this API key");
  }
  c.set("project", found.project);
  c.set("apiKey", found.key);
  return null;
}

export function requireKey(deps: ApiDeps, scope: KeyScope): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const denied = await authenticate(c, deps, bearer(c), scope);
    if (denied) return denied;
    await next();
  };
}
