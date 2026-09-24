import { Hono } from "hono";
import { z } from "zod";
import type { ApiDeps, AppEnv } from "../deps.js";
import { apiError } from "../errors.js";
import { requireKey } from "../middleware/apiKey.js";
import { readJson } from "./signals.js";
import { UUID_RE } from "@proofline/db";

const FeedbackBody = z.object({
  decision_id: z.string().regex(UUID_RE, "must be a decision id"),
  label: z.enum(["false_positive", "confirmed_bot"]),
  note: z.string().max(1000).optional(),
});

export function feedbackRoutes(deps: ApiDeps) {
  const app = new Hono<AppEnv>();
  app.post("/feedback", requireKey(deps, "secret"), async (c) => {
    const parsed = await readJson(c, FeedbackBody);
    if (!parsed.ok) return parsed.res;
    const project = c.get("project");
    const decision = await deps.store.getDecision(project.id, parsed.data.decision_id);
    if (!decision) return apiError(c, 404, "not_found", "Unknown decision_id for this project");
    const { id } = await deps.store.insertFeedback({ project_id: project.id, ...parsed.data });
    return c.json({ id }, 201);
  });
  return app;
}
