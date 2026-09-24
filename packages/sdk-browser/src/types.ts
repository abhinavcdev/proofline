/** Mirrors `BrowserSignals` in @proofline/core (kept separate so the SDK has no dependencies). */
export type FieldKind = "text" | "email" | "password" | "tel" | "number" | "textarea" | "select" | "other";
export type HeadlessHint =
  | "no_plugins"
  | "no_languages"
  | "swiftshader_webgl"
  | "zero_outer_size"
  | "headless_ua"
  | "missing_chrome_runtime"
  | "permissions_mismatch";

export interface FieldSignals {
  kind: FieldKind;
  dwell_ms: number;
  keys: number;
  corrections: number;
  pastes: number;
  focus: number;
}

export interface BrowserSignals {
  v: 1;
  consent: boolean;
  page_ms: number;
  fields?: FieldSignals[];
  keys: { count: number; iki_mean_ms: number; iki_var_ms2: number; corrections: number };
  pastes: number;
  pointer: { type: "mouse" | "touch" | "pen" | "none"; events: number; entropy: number };
  focus_blur: number;
  automation: { webdriver: boolean; headless_hints: HeadlessHint[]; viewport_consistent: boolean };
}

export type EventType = "signup" | "login" | "checkout" | "form_submit" | "comment";
