import type { State } from "./types/state.js";

/**
 * Human-readable features extracted from a state. Shared by:
 *  - the heuristic scorer used by MockProvider and RulesOnlyProvider, and
 *  - the policy engine, which surfaces the top features as decision reasons.
 *
 * Weights are log-odds contributions toward "automated": positive means
 * suspicious, negative means human-like.
 */
export interface Feature {
  code: string;
  message: string;
  weight: number;
  /** Which kind of abuse this feature points at, if any. */
  hints?: ReadonlyArray<"scraper" | "spam_bot" | "credential_stuffer" | "farm_account">;
}

export function extractFeatures(state: State): Feature[] {
  const f: Feature[] = [];
  const add = (x: Feature) => f.push(x);

  switch (state.sdk) {
    case "missing":
      add({ code: "sdk_missing", message: "No browser signals were received (script not run or blocked)", weight: 1.2 });
      break;
    case "expired":
      add({ code: "sdk_expired", message: "The browser signal token had expired (possible replay)", weight: 1.0 });
      break;
    case "invalid":
      add({ code: "sdk_invalid", message: "The browser signal token was forged or tampered with", weight: 3.0 });
      break;
    case "replayed":
      add({ code: "sdk_replayed", message: "The browser signal token was already used", weight: 3.0 });
      break;
    case "valid":
      break;
  }

  const a = state.automation;
  if (a?.webdriver) add({ code: "webdriver", message: "The browser reports it is under automation (navigator.webdriver)", weight: 3.5 });
  if (a?.headless_hints?.length)
    add({
      code: "headless_hints",
      message: `Headless-browser traits detected (${a.headless_hints.join(", ")})`,
      weight: 0.8 + 0.4 * Math.min(a.headless_hints.length, 4),
    });
  if (a?.viewport_mismatch)
    add({ code: "viewport_mismatch", message: "Window and screen sizes are inconsistent", weight: 0.7 });

  const b = state.behavior;
  if (b) {
    if (b.time_to_submit === "<2s")
      add({ code: "instant_submit", message: "Form submitted less than 2 seconds after the page loaded", weight: 2.2 });
    else if (b.time_to_submit === "2-5s")
      add({ code: "fast_submit", message: "Form submitted 2–5 seconds after the page loaded", weight: 0.8 });
    else if (b.time_to_submit === "5-30s" || b.time_to_submit === "30s-5m")
      add({ code: "normal_pace", message: "Time on page before submitting was typical for a person", weight: -0.6 });

    const t = b.typing;
    if (t?.cadence === "robotic")
      add({ code: "robotic_typing", message: "Keystrokes arrived faster than people can type", weight: 2.0 });
    if (t?.variability === "none")
      add({ code: "uniform_typing", message: "Keystroke timing was perfectly regular, like a script", weight: 1.8 });
    if (t?.variability === "normal" || t?.variability === "high")
      add({ code: "natural_typing", message: "Typing rhythm varied naturally", weight: -1.2 });
    if (t && t.corrections !== "0")
      add({ code: "corrections", message: "The user corrected typos while typing", weight: -0.8 });

    if (!t && b.pastes === "0" && (b.fields ?? 1) > 0)
      add({ code: "no_input_events", message: "Fields were filled with no typing or pasting events", weight: 1.6 });
    if (b.pasted_fields === "all")
      add({ code: "all_pasted", message: "Every field was pasted rather than typed", weight: 0.6 });

    if (b.pointer === "none")
      add({ code: "no_pointer", message: "No mouse or touch movement before submitting", weight: 1.0 });
    else if (b.pointer === "linear")
      add({ code: "linear_pointer", message: "Mouse moved in unnaturally straight lines", weight: 1.2 });
    else if (b.pointer === "natural" || b.pointer === "touch")
      add({ code: "natural_pointer", message: "Pointer or touch movement looked natural", weight: -1.0 });
  }

  const n = state.network;
  if (n) {
    if (n.known_bad_ip) add({ code: "known_bad_ip", message: "The network address is on a known-abuse list", weight: 3.0 });
    if (n.asn_class === "datacenter")
      add({ code: "datacenter_ip", message: "Traffic came from a hosting/datacenter network, not a consumer ISP", weight: 1.1, hints: ["scraper", "farm_account"] });
    if (n.asn_class === "residential" || n.asn_class === "mobile")
      add({ code: "consumer_network", message: "Traffic came from a consumer or mobile network", weight: -0.3 });
    const burst = [n.rate_ip, n.rate_fingerprint].includes("burst");
    const elevated = [n.rate_ip, n.rate_fingerprint, n.rate_asn].includes("elevated") || n.rate_asn === "burst";
    if (burst)
      add({ code: "rate_burst", message: "Burst of requests from the same address or device fingerprint", weight: 2.0, hints: ["credential_stuffer", "farm_account"] });
    else if (elevated)
      add({ code: "rate_elevated", message: "Higher than normal request rate from this source", weight: 0.9, hints: ["credential_stuffer"] });
    if (n.header_anomalies?.length)
      add({
        code: "header_anomalies",
        message: `Request headers are inconsistent with a real browser (${n.header_anomalies.join(", ")})`,
        weight: 0.5 + 0.4 * Math.min(n.header_anomalies.length, 3),
      });
    if (n.declared_agent === "unverified_claim")
      add({ code: "unverified_agent", message: "Claims to be a known agent but the signature did not verify", weight: 1.5, hints: ["scraper"] });
  }

  const acc = state.account;
  if (acc) {
    if (acc.email === "disposable")
      add({ code: "disposable_email", message: "Uses a disposable email provider", weight: 1.4, hints: ["farm_account", "spam_bot"] });
    if (acc.age === "30-365d" || acc.age === ">1y")
      add({ code: "established_account", message: "Long-standing account", weight: -0.8 });
    if (acc.blocked_30d && acc.blocked_30d !== "0")
      add({ code: "prior_blocks", message: "This account was blocked in the last 30 days", weight: 1.0 });
  }

  if (state.pow === "failed" || state.pow === "replayed")
    add({ code: "pow_failed", message: "The proof-of-work was missing, wrong or reused", weight: 2.5 });
  if (state.pow === "passed") add({ code: "pow_passed", message: "Proof-of-work was solved", weight: -0.2 });

  const text = state.text;
  if (text) {
    if (text.links >= 2)
      add({ code: "many_links", message: `The message contains ${text.links} links`, weight: 1.0 + 0.2 * Math.min(text.links, 5), hints: ["spam_bot"] });
    if (templatedTextScore(text.excerpt) >= 0.5)
      add({ code: "templated_text", message: "The message reads like generic promotional boilerplate", weight: 1.2, hints: ["spam_bot"] });
  }

  if (state.event === "login" && f.some((x) => x.code === "rate_burst" || x.code === "rate_elevated")) {
    add({ code: "login_velocity", message: "Many login attempts in a short time", weight: 0.8, hints: ["credential_stuffer"] });
  }

  return f;
}

const SPAM_TERMS = [
  "seo", "backlink", "casino", "crypto", "bitcoin", "viagra", "cheap", "discount", "click here", "buy now",
  "limited offer", "work from home", "earn $", "free money", "guaranteed", "loan", "increase your traffic",
  "dear sir", "dear webmaster", "rank your website", "promotion",
];

/** 0..1 heuristic for boilerplate/spam text. Used by the offline providers only. */
export function templatedTextScore(excerpt: string): number {
  const lower = excerpt.toLowerCase();
  let score = 0;
  const hits = SPAM_TERMS.filter((t) => lower.includes(t)).length;
  score += Math.min(hits * 0.25, 0.75);
  if ((lower.match(/<url>/g)?.length ?? 0) >= 2) score += 0.25;
  const letters = excerpt.replace(/[^A-Za-z]/g, "");
  if (letters.length > 20 && letters.replace(/[^A-Z]/g, "").length / letters.length > 0.6) score += 0.2;
  if (/(.)\1{5,}/.test(excerpt)) score += 0.1;
  return Math.min(score, 1);
}

/** Most important features first, suspicious before human-like. */
export function topFeatures(features: Feature[], n: number): Feature[] {
  return [...features].sort((a, b) => b.weight - a.weight).slice(0, n);
}
