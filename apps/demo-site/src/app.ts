import { Hono } from "hono";
import { PASS_FIELD, clientFromHeaders, tokenFromForm, type AssessContext, type AssessResult, type EventType, type Proofline } from "@proofline/sdk-server";
import * as views from "./views.js";

export interface DemoOptions {
  proofline: Proofline;
  publishableKey: string;
  /** Public URL of the Proofline API, as the browser sees it. */
  apiUrl: string;
  /** The built browser SDK (IIFE). */
  sdkScript: () => Promise<string>;
  /** The built challenge UI (IIFE). */
  challengeScript?: () => Promise<string>;
  /** Socket address for a request, when running on Node. */
  remoteAddress?: (req: Request, env: unknown) => string | undefined;
  trustProxy?: boolean;
}

export interface Submission {
  event: EventType;
  decision: AssessResult;
}

/**
 * Crumb & Co. Bakery. Every POST handler calls `assess()` and follows the
 * action. The project starts in shadow mode, so every action comes back as
 * `allow` and every submission goes through.
 */
export function createDemoApp(opts: DemoOptions) {
  const app = new Hono();
  const page = { publishableKey: opts.publishableKey, apiUrl: opts.apiUrl };
  const submissions: Submission[] = [];
  /** Submissions waiting on a step-up, by challenge id. A real site would keep these in its session store. */
  const pending = new Map<string, Submission & { success: [string, string]; at: number }>();
  const PENDING_TTL_MS = 15 * 60_000;

  app.get("/", (c) => c.html(views.home(page)));
  app.get("/signup", (c) => c.html(views.signup(page)));
  app.get("/login", (c) => c.html(views.login(page)));
  app.get("/contact", (c) => c.html(views.contact(page)));
  app.get("/checkout", (c) => c.html(views.checkout(page)));
  app.get("/proofline.js", async (c) => c.body(await opts.sdkScript(), 200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" }));
  app.get("/proofline-challenge.js", async (c) =>
    c.body(opts.challengeScript ? await opts.challengeScript() : "", 200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" }),
  );

  app.get("/verify", (c) => {
    const id = c.req.query("c") ?? "";
    if (!pending.has(id)) return c.html(views.result(page, "This check has ended", "Please submit the form again.", { action: "none" }), 404);
    return c.html(views.challenge(page, id));
  });

  // The challenge UI posts the pass token here. Verify it server-side, then finish the original submission.
  app.post("/verify/complete", async (c) => {
    const form = await c.req.parseBody();
    const challengeId = String(form.challenge_id ?? "");
    const p = pending.get(challengeId);
    const v = await opts.proofline.verifyPassToken(typeof form[PASS_FIELD] === "string" ? form[PASS_FIELD] : undefined);
    if (!p || Date.now() - p.at > PENDING_TTL_MS || !v.valid || v.challenge_id !== challengeId || v.decision_id !== p.decision.decision_id) {
      return c.html(views.result(page, "We couldn't confirm that", "Please submit the form again.", { action: "none" }), 403);
    }
    pending.delete(challengeId);
    submissions.push({ event: p.event, decision: p.decision });
    return c.html(views.result(page, p.success[0], p.success[1], { action: `passed ${v.rung}`, decision_id: p.decision.decision_id }));
  });

  const handle = (event: EventType, contextOf: (form: Record<string, string>) => AssessContext, success: [string, string]) =>
    app.post(`/${event === "form_submit" ? "contact" : event}`, async (c) => {
      const raw = await c.req.parseBody();
      const form = Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === "string"));
      const decision = await opts.proofline.assess({
        eventType: event,
        token: tokenFromForm(form),
        context: contextOf(form),
        ...(form.email ? { contact: { email: form.email } } : {}),
        client: clientFromHeaders(c.req.raw.headers, {
          remoteAddress: opts.remoteAddress?.(c.req.raw, c.env),
          trustProxy: opts.trustProxy ?? false,
        }),
      });
      const view = { action: decision.action, would_have: decision.would_have, mode: decision.mode, decision_id: decision.decision_id, degraded: decision.degraded };

      if (decision.action === "block") {
        return c.html(views.result(page, "We couldn't accept that", "Something about this request looked automated. If you're a person, please try again or email hello@crumb.example.", view), 403);
      }
      if (decision.action.startsWith("step_up:")) {
        if (decision.challenge) {
          pending.set(decision.challenge.id, { event, decision, success, at: Date.now() });
          return c.redirect(`/verify?c=${encodeURIComponent(decision.challenge.id)}`, 303);
        }
        return c.html(views.result(page, "One more step", "We need to confirm it's you before continuing. We'll email you shortly.", view), 202);
      }
      // shadow_drop: look successful, but don't act on it.
      if (decision.action !== "shadow_drop") submissions.push({ event, decision });
      return c.html(views.result(page, success[0], success[1], view));
    });

  const emailDomain = (email?: string) => email?.split("@")[1]?.toLowerCase();

  // The demo has no user database, so the account id is derived from the email address.
  const accountId = (email?: string) => (email ? `demo:${email.trim().toLowerCase()}` : undefined);
  const account = (f: Record<string, string>, extra: Record<string, unknown> = {}) => ({
    ...(accountId(f.email) ? { id: accountId(f.email)! } : {}),
    ...(emailDomain(f.email) ? { email_domain: emailDomain(f.email)! } : {}),
    ...extra,
  });

  handle("signup", (f) => ({ account: account(f, { age_days: 0 }) }), ["Welcome to the bread club!", "Your account is ready."]);
  handle("login", (f) => ({ account: account(f) }), ["You're logged in", "Welcome back to the bread club."]);
  handle("form_submit", (f) => ({ ...(f.message ? { text: f.message } : {}), account: emailDomain(f.email) ? { email_domain: emailDomain(f.email)! } : {} }), [
    "Thanks for your message",
    "We'll get back to you within a day.",
  ]);
  handle("checkout", (f) => ({ account: emailDomain(f.email) ? { email_domain: emailDomain(f.email)! } : {} }), [
    "Order placed",
    "See you at the counter!",
  ]);

  return { app, submissions };
}
