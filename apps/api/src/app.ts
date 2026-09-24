import { Hono } from "hono";
import { redact } from "@proofline/core";
import type { ApiDeps, AppEnv } from "./deps.js";
import { apiError } from "./errors.js";
import { timing } from "./middleware/timing.js";
import { assessRoutes } from "./routes/assess.js";
import { feedbackRoutes } from "./routes/feedback.js";
import { signalsRoutes } from "./routes/signals.js";

export function createApp(deps: ApiDeps) {
  if (!deps.tokenSecrets.length) throw new Error("At least one token signing secret is required");
  const app = new Hono<AppEnv>();

  app.use("/v1/*", timing(() => performance.now()));
  app.get("/v1/health", (c) => c.json({ ok: true }));
  app.route("/v1", signalsRoutes(deps));
  app.route("/v1", assessRoutes(deps));
  app.route("/v1", feedbackRoutes(deps));

  app.notFound((c) => apiError(c, 404, "not_found", "No such route"));
  app.onError((err, c) => {
    deps.logger?.error("unhandled", redact({ path: c.req.path, error: String(err) }));
    return apiError(c, 500, "internal", "Internal error");
  });
  return app;
}
