import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../deps.js";

/** Per-request stage timings, returned in `Server-Timing` and stored with each decision. */
export function timing(now: () => number): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const t0 = now();
    c.set("timings", {});
    await next();
    const timings = c.get("timings");
    timings.total = Math.round((now() - t0) * 10) / 10;
    c.header(
      "Server-Timing",
      Object.entries(timings)
        .map(([k, v]) => `${k};dur=${v}`)
        .join(", "),
    );
  };
}

export async function timed<T>(c: { get(k: "timings"): Record<string, number> }, name: string, now: () => number, fn: () => Promise<T> | T): Promise<T> {
  const t = now();
  try {
    return await fn();
  } finally {
    c.get("timings")[name] = Math.round((now() - t) * 10) / 10;
  }
}
