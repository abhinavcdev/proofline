import { permissionsHint } from "./automation.js";
import { FormCollector } from "./collector.js";
import { solveInWorker } from "./pow.js";
import type { BrowserSignals, EventType } from "./types.js";

export type { BrowserSignals, EventType } from "./types.js";

/**
 * Proofline browser SDK.
 *
 *   <script async src="proofline.js" data-key="pl_pk_…" data-api="https://api.proofline.dev"></script>
 *   <form data-proofline-event="signup"> … </form>
 *
 * On submit it asks Proofline for a signed token (≤ 300 ms) and writes it to a
 * hidden `proofline_token` field. If that is slow or fails, the form submits
 * without a token: a missing token is a signal, not an error. Nothing here
 * throws into page code.
 */

export interface InitOptions {
  /** Publishable key (`pl_pk_…`). */
  key: string;
  apiUrl?: string;
  /** false = send only behavioural counters and automation flags (no per-field detail). Default true. */
  consent?: boolean;
  /** Token request budget. Default 300 ms. */
  timeoutMs?: number;
  /** Solve the project's proof-of-work challenge if it has one. Default true. */
  pow?: boolean;
  /** Attach to forms with `data-proofline-event` automatically. Default true. */
  autoAttach?: boolean;
}

const TOKEN_FIELD = "proofline_token";
const DEFAULT_API = "https://api.proofline.dev";
const EVENTS: readonly EventType[] = ["signup", "login", "checkout", "form_submit", "comment"];

interface Config {
  key: string;
  api: string;
  consent: boolean;
  timeoutMs: number;
}

let config: Config | null = null;
let powSolution: Promise<{ token: string; nonce: string } | null> = Promise.resolve(null);
let permissionHint: Promise<Awaited<ReturnType<typeof permissionsHint>>> = Promise.resolve(null);
const collectors = new WeakMap<HTMLFormElement, FormCollector>();
const bypass = new WeakSet<HTMLFormElement>();

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

async function post<T>(path: string, body: unknown, timeoutMs: number): Promise<T | null> {
  if (!config) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${config.api}${path}`, {
      method: "POST",
      // text/plain keeps this a "simple" CORS request: no preflight round trip.
      headers: { "content-type": "text/plain;charset=UTF-8" },
      body: JSON.stringify(body),
      credentials: "omit",
      signal: controller.signal,
    });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function init(opts: InitOptions): void {
  safe(() => {
    if (!opts?.key) return;
    config = {
      key: opts.key,
      api: (opts.apiUrl ?? DEFAULT_API).replace(/\/+$/, ""),
      consent: opts.consent !== false,
      timeoutMs: opts.timeoutMs ?? 300,
    };
    permissionHint = permissionsHint();
    if (opts.pow !== false) {
      powSolution = post<{ enabled: boolean; token?: string; salt?: string; bits?: number }>("/v1/pow", { key: config.key }, 3_000).then(
        async (ch) => {
          if (!ch?.enabled || !ch.token || !ch.salt || !ch.bits) return null;
          const nonce = await solveInWorker(ch.salt, ch.bits);
          return nonce === null ? null : { token: ch.token, nonce };
        },
      );
    }
    if (opts.autoAttach !== false) {
      const run = () => document.querySelectorAll<HTMLFormElement>("form[data-proofline-event]").forEach((f) => attach(f));
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, { once: true });
      else run();
    }
  }, undefined);
}

/** Start collecting for a form. With `autoSubmit` (default) the token is added on submit. */
export function attach(form: HTMLFormElement, opts: { eventType?: EventType; autoSubmit?: boolean } = {}): void {
  safe(() => {
    if (collectors.has(form)) return;
    collectors.set(form, new FormCollector(form, 0));
    if (opts.autoSubmit === false) return;
    form.addEventListener("submit", (e) => onSubmit(e, form, opts.eventType));
  }, undefined);
}

function eventTypeOf(form: HTMLFormElement, explicit?: EventType): EventType {
  const attr = form.getAttribute("data-proofline-event") as EventType | null;
  const t = explicit ?? attr ?? "form_submit";
  return EVENTS.includes(t) ? t : "form_submit";
}

function onSubmit(e: SubmitEvent, form: HTMLFormElement, explicit?: EventType) {
  if (bypass.has(form)) {
    bypass.delete(form);
    return;
  }
  if (e.defaultPrevented) return; // The page handles submission itself; it can call token().
  e.preventDefault();
  const submitter = e.submitter;
  void token(eventTypeOf(form, explicit), form).then((t) => {
    safe(() => {
      setHiddenToken(form, t);
      bypass.add(form);
      if (typeof form.requestSubmit === "function") {
        form.requestSubmit(submitter && form.contains(submitter) ? (submitter as HTMLButtonElement) : undefined);
      } else {
        HTMLFormElement.prototype.submit.call(form);
      }
    }, undefined);
  });
}

function setHiddenToken(form: HTMLFormElement, value: string | null) {
  let input = form.querySelector<HTMLInputElement>(`input[name="${TOKEN_FIELD}"]`);
  if (!input) {
    input = document.createElement("input");
    input.type = "hidden";
    input.name = TOKEN_FIELD;
    form.appendChild(input);
  }
  input.value = value ?? "";
}

/**
 * Get a signal token for an event, for pages that submit with fetch. Resolves
 * to null (never rejects) if Proofline isn't configured, is slow, or fails.
 */
export async function token(eventType: EventType, form?: HTMLFormElement): Promise<string | null> {
  try {
    if (!config) return null;
    const start = performance.now();
    const collector = form ? collectors.get(form) : undefined;
    const hint = await Promise.race([permissionHint, Promise.resolve(null)]);
    if (hint) collector?.addHint(hint);
    const signals: BrowserSignals = collector ? collector.snapshot(config.consent) : emptySignals(config.consent);
    // Use a PoW solution only if it's already done; never wait for it here.
    const pow = await Promise.race([powSolution, new Promise<null>((r) => setTimeout(() => r(null), 0))]);
    const remaining = Math.max(50, config.timeoutMs - (performance.now() - start));
    const res = await post<{ token: string }>(
      "/v1/signals",
      { key: config.key, event_type: eventType, signals, ...(pow ? { pow } : {}) },
      remaining,
    );
    return res?.token ?? null;
  } catch {
    return null;
  }
}

function emptySignals(consent: boolean): BrowserSignals {
  const c = new FormCollector(document.createElement("form"), 0);
  const s = c.snapshot(consent);
  c.destroy();
  return s;
}

// Auto-init from the script tag's data attributes.
safe(() => {
  const script = typeof document !== "undefined" ? (document.currentScript as HTMLScriptElement | null) : null;
  const key = script?.dataset.key;
  if (key) {
    init({
      key,
      ...(script.dataset.api ? { apiUrl: script.dataset.api } : {}),
      ...(script.dataset.consent === "false" ? { consent: false } : {}),
    });
  }
}, undefined);
