import { automationSignals } from "./automation.js";
import { AngleHistogram, Welford } from "./stats.js";
import type { BrowserSignals, FieldKind, FieldSignals, HeadlessHint } from "./types.js";

/**
 * Collects aggregate interaction signals for one form. Only counters, timings
 * and running statistics are kept: never key values, field names or contents.
 */

const MAX_FIELDS = 64;
const MAX_IKI_MS = 5_000;
const MIN_MOVE_PX = 3;

function kindOf(el: Element): FieldKind | null {
  if (el instanceof HTMLTextAreaElement) return "textarea";
  if (el instanceof HTMLSelectElement) return "select";
  if (!(el instanceof HTMLInputElement)) return null;
  switch (el.type) {
    case "hidden":
    case "submit":
    case "button":
    case "reset":
    case "image":
      return null;
    case "text":
    case "search":
      return "text";
    case "email":
    case "password":
    case "tel":
    case "number":
      return el.type;
    default:
      return "other";
  }
}

interface FieldState extends FieldSignals {
  focusedAt: number;
}

export class FormCollector {
  readonly #form: HTMLFormElement;
  readonly #start: number;
  readonly #fields = new Map<Element, FieldState>();
  readonly #iki = new Welford();
  readonly #angles = new AngleHistogram();
  readonly #extraHints: HeadlessHint[] = [];
  #lastKeyAt = 0;
  #keys = 0;
  #corrections = 0;
  #pastes = 0;
  #pointerEvents = 0;
  #pointerType: BrowserSignals["pointer"]["type"] = "none";
  #last: { x: number; y: number } | null = null;
  #focusBlur = 0;
  readonly #off: Array<() => void> = [];

  constructor(form: HTMLFormElement, pageStart: number) {
    this.#form = form;
    this.#start = pageStart;
    const on = <K extends keyof DocumentEventMap>(t: EventTarget, type: K, fn: (e: DocumentEventMap[K]) => void) => {
      const h = (e: Event) => {
        try {
          fn(e as DocumentEventMap[K]);
        } catch {
          // Never throw into page code.
        }
      };
      t.addEventListener(type, h, { passive: true, capture: true });
      this.#off.push(() => t.removeEventListener(type, h, { capture: true }));
    };
    on(form, "focusin", (e) => this.#focusIn(e.target as Element));
    on(form, "focusout", (e) => this.#focusOut(e.target as Element));
    on(form, "keydown", (e) => this.#key(e));
    on(form, "paste", (e) => this.#paste(e.target as Element));
    on(document, "pointermove", (e) => this.#move(e));
    on(document, "pointerdown", (e) => this.#setPointer(e.pointerType));
    on(window as unknown as EventTarget, "focus", () => this.#focusBlur++);
    on(window as unknown as EventTarget, "blur", () => this.#focusBlur++);
  }

  addHint(h: HeadlessHint): void {
    if (!this.#extraHints.includes(h)) this.#extraHints.push(h);
  }

  destroy(): void {
    for (const off of this.#off) off();
    this.#off.length = 0;
  }

  #field(el: Element): FieldState | null {
    if (!this.#form.contains(el)) return null;
    let f = this.#fields.get(el);
    if (!f) {
      const kind = kindOf(el);
      if (!kind || this.#fields.size >= MAX_FIELDS) return null;
      f = { kind, dwell_ms: 0, keys: 0, corrections: 0, pastes: 0, focus: 0, focusedAt: 0 };
      this.#fields.set(el, f);
    }
    return f;
  }

  #focusIn(el: Element) {
    const f = this.#field(el);
    if (!f) return;
    f.focus++;
    f.focusedAt = performance.now();
    this.#focusBlur++;
  }

  #focusOut(el: Element) {
    const f = this.#fields.get(el);
    if (!f || !f.focusedAt) return;
    f.dwell_ms += performance.now() - f.focusedAt;
    f.focusedAt = 0;
    this.#focusBlur++;
  }

  #key(e: KeyboardEvent) {
    // Only the key *category* is looked at: correction vs anything that types.
    const isCorrection = e.key === "Backspace" || e.key === "Delete";
    const types = isCorrection || e.key.length === 1;
    if (!types || e.ctrlKey || e.metaKey) return;
    const f = this.#field(e.target as Element);
    const now = performance.now();
    if (this.#lastKeyAt) {
      const iki = now - this.#lastKeyAt;
      if (iki < MAX_IKI_MS) this.#iki.push(iki);
    }
    this.#lastKeyAt = now;
    this.#keys++;
    if (f) f.keys++;
    if (isCorrection) {
      this.#corrections++;
      if (f) f.corrections++;
    }
  }

  #paste(el: Element) {
    this.#pastes++;
    const f = this.#field(el);
    if (f) f.pastes++;
  }

  #setPointer(t: string) {
    if (t === "mouse" || t === "touch" || t === "pen") this.#pointerType = t;
  }

  #move(e: PointerEvent) {
    this.#pointerEvents++;
    if (this.#pointerType === "none") this.#setPointer(e.pointerType);
    const p = { x: e.clientX, y: e.clientY };
    if (this.#last) {
      const dx = p.x - this.#last.x;
      const dy = p.y - this.#last.y;
      if (Math.abs(dx) + Math.abs(dy) < MIN_MOVE_PX) return;
      this.#angles.push(dx, dy);
    }
    this.#last = p;
  }

  snapshot(consent: boolean): BrowserSignals {
    const now = performance.now();
    const fields = [...this.#fields.values()].map((f) => ({
      kind: f.kind,
      dwell_ms: Math.round(f.dwell_ms + (f.focusedAt ? now - f.focusedAt : 0)),
      keys: f.keys,
      corrections: f.corrections,
      pastes: f.pastes,
      focus: f.focus,
    }));
    const automation = automationSignals();
    for (const h of this.#extraHints) if (!automation.headless_hints.includes(h)) automation.headless_hints.push(h);
    const clamp = (n: number, max: number) => Math.max(0, Math.min(max, n));
    return {
      v: 1,
      consent,
      page_ms: Math.round(clamp(now - this.#start, 86_400_000)),
      ...(consent ? { fields } : {}),
      keys: {
        count: this.#keys,
        iki_mean_ms: clamp(Math.round(this.#iki.mean * 10) / 10, 60_000),
        iki_var_ms2: clamp(Math.round(this.#iki.variance), 3.6e9),
        corrections: this.#corrections,
      },
      pastes: this.#pastes,
      pointer: {
        type: this.#pointerType,
        events: this.#pointerEvents,
        entropy: Math.round(this.#angles.entropy() * 1000) / 1000,
      },
      focus_blur: this.#focusBlur,
      automation,
    };
  }
}
