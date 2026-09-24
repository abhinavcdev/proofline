/**
 * Proofline server SDK. Call `assess()` from your form handlers.
 *
 * It fails open: if Proofline is slow, down or misconfigured, `assess()`
 * resolves to `{ action: "allow", degraded: true }` rather than throwing, so
 * your forms keep working. Misconfiguration (bad key, 4xx) is reported through
 * `onError` so it doesn't go unnoticed.
 */

export type EventType = "signup" | "login" | "checkout" | "form_submit" | "comment";
export type Rung = "pow" | "passkey" | "email_otp" | "id_verify" | "review";
export type Action = "allow" | "block" | "shadow_drop" | "agent_lane" | `step_up:${Rung}`;

/** Name of the hidden form field the browser SDK writes. */
export const TOKEN_FIELD = "proofline_token";

export interface Reason {
  code: string;
  message: string;
  weight?: number;
  evidence?: Record<string, string | number | boolean>;
}

export interface AssessContext {
  account?: {
    age_days?: number;
    /** Domain only (e.g. "gmail.com"), never the full address. */
    email_domain?: string;
    has_passkey?: boolean;
    has_verified_email?: boolean;
  };
  history?: { events_30d: number; blocked_30d: number; stepped_up_30d: number };
  /** Free text for content checks (comment body, contact message). */
  text?: string;
}

export interface ClientInfo {
  ip?: string;
  user_agent?: string;
  accept_language?: string;
}

export interface AssessInput {
  eventType: EventType;
  /** The `proofline_token` field from the submitted form. Missing is fine. */
  token?: string | null | undefined;
  context?: AssessContext;
  /** The end user's connection. Use `clientFromRequest()` or `clientFromHeaders()`. */
  client?: ClientInfo;
}

export interface AssessResult {
  /** What to do now. Always "allow" in shadow mode. */
  action: Action;
  decision_id?: string;
  mode?: "shadow" | "enforce";
  /** Shadow mode only: what enforce mode would have done. */
  would_have?: Action;
  risk?: 0 | 1 | 2 | 3;
  reasons?: Reason[];
  /** True when Proofline couldn't give a full answer (fail-open or rules-only fallback). */
  degraded?: boolean;
  /** Set when failing open. */
  error?: "timeout" | "network" | "http" | "invalid_response";
}

export type FeedbackLabel = "false_positive" | "confirmed_bot";

export interface ProoflineOptions {
  /** `pl_sk_…`. Keep it on the server. */
  secretKey: string;
  baseUrl?: string;
  /** Overall budget for assess(), after which it fails open. Default 800 ms. */
  timeoutMs?: number;
  fetch?: typeof fetch;
  onError?: (err: ProoflineError) => void;
}

export class ProoflineError extends Error {
  constructor(
    readonly kind: NonNullable<AssessResult["error"]>,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProoflineError";
  }
}

export const DEFAULT_BASE_URL = "https://api.proofline.dev";

export function createProofline(opts: ProoflineOptions) {
  if (!/^pl_sk_/.test(opts.secretKey)) throw new Error("Proofline: secretKey must be a secret key (pl_sk_…)");
  const base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? 800;
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);

  async function post(path: string, body: unknown, signal: AbortSignal): Promise<Response> {
    return doFetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${opts.secretKey}` },
      body: JSON.stringify(body),
      signal,
    });
  }

  function failOpen(err: ProoflineError): AssessResult {
    try {
      opts.onError?.(err);
    } catch {
      // Never let a logging hook break the caller.
    }
    return { action: "allow", degraded: true, error: err.kind };
  }

  return {
    async assess(input: AssessInput): Promise<AssessResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await post(
          "/v1/assess",
          {
            event_type: input.eventType,
            ...(input.token ? { signal_token: input.token } : {}),
            ...(input.context ? { context: input.context } : {}),
            ...(input.client ? { client: input.client } : {}),
          },
          controller.signal,
        );
        if (!res.ok) return failOpen(new ProoflineError("http", `Proofline assess failed with HTTP ${res.status}`, res.status));
        const json = (await res.json().catch(() => null)) as AssessResult | null;
        if (typeof json?.action !== "string") return failOpen(new ProoflineError("invalid_response", "Unexpected response from Proofline"));
        return json;
      } catch (err) {
        return failOpen(
          controller.signal.aborted
            ? new ProoflineError("timeout", `Proofline assess timed out after ${timeoutMs} ms`)
            : new ProoflineError("network", `Proofline unreachable: ${String(err)}`),
        );
      } finally {
        clearTimeout(timer);
      }
    },

    /** Label a decision (e.g. a customer who was wrongly stepped up). Throws on failure. */
    async feedback(input: { decisionId: string; label: FeedbackLabel; note?: string }): Promise<{ id: string }> {
      const res = await post(
        "/v1/feedback",
        { decision_id: input.decisionId, label: input.label, ...(input.note ? { note: input.note } : {}) },
        AbortSignal.timeout(5_000),
      );
      if (!res.ok) throw new ProoflineError("http", `Proofline feedback failed with HTTP ${res.status}`, res.status);
      return (await res.json()) as { id: string };
    },
  };
}

export type Proofline = ReturnType<typeof createProofline>;

/**
 * Client details from request headers. Only trust forwarding headers your own
 * proxy sets: pass `trustProxy: true` when you run behind one.
 */
export function clientFromHeaders(
  headers: Headers | Record<string, string | string[] | undefined>,
  opts: { remoteAddress?: string | undefined; trustProxy?: boolean } = {},
): ClientInfo {
  const get = (name: string): string | undefined => {
    if (headers instanceof Headers) return headers.get(name) ?? undefined;
    const v = headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  const forwarded = opts.trustProxy
    ? (get("cf-connecting-ip") ?? get("x-real-ip") ?? get("x-forwarded-for")?.split(",")[0]?.trim())
    : undefined;
  const ip = forwarded ?? opts.remoteAddress;
  const ua = get("user-agent");
  const lang = get("accept-language");
  return {
    ...(ip ? { ip } : {}),
    ...(ua ? { user_agent: ua.slice(0, 512) } : {}),
    ...(lang ? { accept_language: lang.slice(0, 256) } : {}),
  };
}

export function clientFromRequest(request: Request, opts: { remoteAddress?: string; trustProxy?: boolean } = {}): ClientInfo {
  return clientFromHeaders(request.headers, opts);
}

/** Read the token from parsed form data (FormData or a plain object). */
export function tokenFromForm(form: FormData | Record<string, unknown>): string | undefined {
  const v = form instanceof FormData ? form.get(TOKEN_FIELD) : form[TOKEN_FIELD];
  return typeof v === "string" && v.length > 0 && v.length <= 8192 ? v : undefined;
}
