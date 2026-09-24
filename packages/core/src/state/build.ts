import { TEXT_EVENT_TYPES, type EventType } from "../types/events.js";
import type { BrowserSignals, EdgeSignals, PowStatus, ServerContext, TokenStatus } from "../types/signals.js";
import { State } from "../types/state.js";
import {
  RATE_THRESHOLDS,
  ageBucket,
  cadenceBucket,
  countBucket,
  pointerBucket,
  rateBucket,
  timeBucket,
  variabilityBucket,
} from "./buckets.js";
import { classifyEmailDomain } from "./email.js";
import { redactText } from "./text.js";

export const STATE_TOKEN_BUDGET = 600;

export interface BuildStateInput {
  event: EventType;
  token: TokenStatus;
  browser?: BrowserSignals | undefined;
  edge?: EdgeSignals | undefined;
  server?: ServerContext | undefined;
  pow?: PowStatus | undefined;
}

/** Conservative token estimate for compact JSON (~3.5 chars/token for this shape). */
export function estimateTokens(state: unknown): number {
  return Math.ceil(JSON.stringify(state).length / 3.5);
}

/** Merge browser, edge and server context into one compact, privacy-safe state. */
export function buildState(input: BuildStateInput): State {
  const { event, browser, edge, server } = input;
  const state: State = { v: 1, event, sdk: input.token };

  if (browser) {
    const typed = browser.keys.count > 0;
    const filled = browser.fields?.filter((f) => f.keys > 0 || f.pastes > 0) ?? [];
    const pastedOnly = filled.filter((f) => f.pastes > 0 && f.keys === 0).length;
    state.behavior = {
      time_to_submit: timeBucket(browser.page_ms),
      ...(browser.fields ? { fields: browser.fields.length } : {}),
      ...(typed
        ? {
            typing: {
              keys: countBucket(browser.keys.count),
              ...(browser.keys.count >= 5
                ? {
                    cadence: cadenceBucket(browser.keys.iki_mean_ms),
                    variability: variabilityBucket(browser.keys.iki_mean_ms, browser.keys.iki_var_ms2),
                  }
                : {}),
              corrections:
                browser.keys.corrections === 0 ? "0" : browser.keys.corrections <= 2 ? "1-2" : "3+",
            },
          }
        : {}),
      pastes: browser.pastes === 0 ? "0" : browser.pastes === 1 ? "1" : "2+",
      ...(filled.length
        ? { pasted_fields: pastedOnly === 0 ? "none" : pastedOnly === filled.length ? "all" : "some" }
        : {}),
      pointer: pointerBucket(browser.pointer.type, browser.pointer.events, browser.pointer.entropy),
      focus_changes: countBucket(browser.focus_blur),
    };

    const a = browser.automation;
    if (a.webdriver || a.headless_hints.length || !a.viewport_consistent) {
      state.automation = {
        ...(a.webdriver ? { webdriver: true as const } : {}),
        ...(a.headless_hints.length ? { headless_hints: [...a.headless_hints].sort() } : {}),
        ...(!a.viewport_consistent ? { viewport_mismatch: true as const } : {}),
      };
    }
  }

  if (edge) {
    state.network = {
      asn_class: edge.asn_class,
      ...(edge.country ? { country: edge.country } : {}),
      rate_ip: rateBucket(edge.rate.ip_1m, RATE_THRESHOLDS.ip),
      rate_asn: rateBucket(edge.rate.asn_1m, RATE_THRESHOLDS.asn),
      rate_fingerprint: rateBucket(edge.rate.fp_1m, RATE_THRESHOLDS.fingerprint),
      ...(edge.header_anomalies.length ? { header_anomalies: [...edge.header_anomalies].sort() } : {}),
      ...(edge.declared_agent.status === "verified"
        ? { declared_agent: `verified:${edge.declared_agent.name ?? "unknown"}` }
        : edge.declared_agent.status === "unverified_claim"
          ? { declared_agent: "unverified_claim" }
          : {}),
      ...(edge.known_bad_ip ? { known_bad_ip: true as const } : {}),
    };
  }

  if (server?.account || server?.history) {
    const acc = server.account;
    const h = server.history;
    const account: NonNullable<State["account"]> = {
      ...(acc?.age_days !== undefined ? { age: ageBucket(acc.age_days) } : {}),
      ...(acc?.email_domain !== undefined ? { email: classifyEmailDomain(acc.email_domain) } : {}),
      ...(h
        ? {
            events_30d: countBucket(h.events_30d),
            blocked_30d: countBucket(h.blocked_30d),
            stepped_up_30d: countBucket(h.stepped_up_30d),
          }
        : {}),
    };
    if (Object.keys(account).length) state.account = account;
  }

  if (input.pow && input.pow !== "absent") state.pow = input.pow;

  if (server?.text && TEXT_EVENT_TYPES.has(event) && server.text.trim()) {
    state.text = redactText(server.text);
  }

  return fitBudget(State.parse(state));
}

/**
 * Drop low-value detail, in a fixed order, until the state fits the budget.
 * With a 280-char excerpt the normal state is well under budget; this guards
 * against future field growth.
 */
function fitBudget(state: State): State {
  const steps: Array<(s: State) => void> = [
    (s) => {
      if (s.text) s.text.excerpt = s.text.excerpt.slice(0, 140);
    },
    (s) => {
      if (s.network) delete s.network.country;
    },
    (s) => {
      if (s.account) {
        delete s.account.stepped_up_30d;
        delete s.account.events_30d;
      }
    },
    (s) => {
      if (s.text) s.text.excerpt = s.text.excerpt.slice(0, 60);
    },
  ];
  for (const step of steps) {
    if (estimateTokens(state) <= STATE_TOKEN_BUDGET) break;
    step(state);
  }
  return state;
}
