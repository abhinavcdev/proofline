/** Welford's online mean/variance: constant memory, no stored samples. */
export class Welford {
  n = 0;
  mean = 0;
  #m2 = 0;

  push(x: number): void {
    this.n++;
    const d = x - this.mean;
    this.mean += d / this.n;
    this.#m2 += d * (x - this.mean);
  }

  get variance(): number {
    return this.n > 1 ? this.#m2 / (this.n - 1) : 0;
  }
}

/** Histogram of pointer movement directions; entropy near 0 = straight lines, near 1 = natural. */
export class AngleHistogram {
  readonly bins: number[];
  total = 0;
  constructor(readonly size = 16) {
    this.bins = new Array<number>(size).fill(0);
  }

  push(dx: number, dy: number): void {
    const a = Math.atan2(dy, dx) + Math.PI; // 0..2π
    const i = Math.min(this.size - 1, Math.floor((a / (2 * Math.PI)) * this.size));
    this.bins[i]!++;
    this.total++;
  }

  /** Shannon entropy normalised to 0..1. */
  entropy(): number {
    if (this.total < 2) return 0;
    let h = 0;
    for (const c of this.bins) {
      if (c === 0) continue;
      const p = c / this.total;
      h -= p * Math.log2(p);
    }
    return Math.min(1, h / Math.log2(this.size));
  }
}
