/**
 * Sliding-window rate counters (the two-bucket approximation):
 *
 *   count ≈ previous_window × (1 − elapsed_fraction) + current_window
 *
 * `SlidingWindowCounters` is pure in-memory state. `MemoryRateCounter` uses it
 * directly, and the API's Durable Object keeps one per shard.
 */

export const RATE_WINDOW_MS = 60_000;

/** Hard per-minute limits. Above these the event is blocked by deterministic checks. */
export const HARD_RATE_LIMITS = { ip: 120, asn: 5_000, fingerprint: 600 } as const;

export interface RateCounter {
  /** Record one hit for each key and return each key's trailing-window count, including this hit. */
  hit(keys: readonly string[], nowMs?: number): Promise<number[]>;
}

interface Window {
  start: number;
  prev: number;
  curr: number;
}

export class SlidingWindowCounters {
  readonly #windows = new Map<string, Window>();
  constructor(
    readonly windowMs: number = RATE_WINDOW_MS,
    readonly maxKeys: number = 100_000,
  ) {}

  hit(key: string, nowMs: number): number {
    const start = Math.floor(nowMs / this.windowMs) * this.windowMs;
    let w = this.#windows.get(key);
    if (!w) {
      if (this.#windows.size >= this.maxKeys) this.#evict(start);
      w = { start, prev: 0, curr: 0 };
      this.#windows.set(key, w);
    } else if (w.start !== start) {
      w.prev = w.start === start - this.windowMs ? w.curr : 0;
      w.curr = 0;
      w.start = start;
    }
    w.curr += 1;
    const elapsed = (nowMs - start) / this.windowMs;
    return Math.round(w.prev * (1 - elapsed) + w.curr);
  }

  get size(): number {
    return this.#windows.size;
  }

  #evict(currentStart: number) {
    for (const [k, w] of this.#windows) if (w.start < currentStart - this.windowMs) this.#windows.delete(k);
    // Still full (a flood of distinct keys): drop the oldest half.
    if (this.#windows.size >= this.maxKeys) {
      let n = Math.floor(this.maxKeys / 2);
      for (const k of this.#windows.keys()) {
        if (n-- <= 0) break;
        this.#windows.delete(k);
      }
    }
  }
}

export class MemoryRateCounter implements RateCounter {
  readonly #c: SlidingWindowCounters;
  constructor(
    private readonly now: () => number = Date.now,
    windowMs = RATE_WINDOW_MS,
  ) {
    this.#c = new SlidingWindowCounters(windowMs);
  }

  async hit(keys: readonly string[], nowMs: number = this.now()): Promise<number[]> {
    return keys.map((k) => this.#c.hit(k, nowMs));
  }
}
