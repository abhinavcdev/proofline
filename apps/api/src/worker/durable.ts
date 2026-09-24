import { DurableObject } from "cloudflare:workers";
import type { ReplayGuard } from "@proofline/core";
import { SlidingWindowCounters, type RateCounter } from "@proofline/edge";

/**
 * Rate counters and one-time token ids, sharded across Durable Objects by key.
 * State is in memory: a DO restart forgets at most one minute of counts, and
 * every token id it tracks expires within five minutes anyway.
 */
export class RateLimiterDO extends DurableObject {
  readonly #counters = new SlidingWindowCounters();
  readonly #seen = new Map<string, number>();

  hit(keys: string[], nowMs: number): number[] {
    return keys.map((k) => this.#counters.hit(k, nowMs));
  }

  consume(jti: string, expiresAtSec: number, nowMs: number): boolean {
    const nowSec = Math.floor(nowMs / 1000);
    if (this.#seen.size > 50_000) for (const [k, exp] of this.#seen) if (exp <= nowSec) this.#seen.delete(k);
    const exp = this.#seen.get(jti);
    if (exp !== undefined && exp > nowSec) return false;
    this.#seen.set(jti, expiresAtSec);
    return true;
  }
}

const SHARDS = 32;

function shardOf(key: string): string {
  // FNV-1a: stable, cheap, good enough to spread keys.
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
  return `shard-${(h >>> 0) % SHARDS}`;
}

export class DurableRateCounter implements RateCounter {
  constructor(private readonly ns: DurableObjectNamespace<RateLimiterDO>) {}

  async hit(keys: readonly string[], nowMs: number = Date.now()): Promise<number[]> {
    const groups = new Map<string, number[]>();
    keys.forEach((k, i) => {
      const s = shardOf(k);
      groups.set(s, [...(groups.get(s) ?? []), i]);
    });
    const out = new Array<number>(keys.length).fill(0);
    await Promise.all(
      [...groups].map(async ([shard, idx]) => {
        const counts = await this.ns.get(this.ns.idFromName(shard)).hit(idx.map((i) => keys[i]!), nowMs);
        idx.forEach((i, j) => (out[i] = counts[j] ?? 0));
      }),
    );
    return out;
  }
}

export class DurableReplayGuard implements ReplayGuard {
  constructor(private readonly ns: DurableObjectNamespace<RateLimiterDO>) {}

  consume(jti: string, expiresAtSec: number): Promise<boolean> {
    return this.ns.get(this.ns.idFromName(shardOf(`jti:${jti}`))).consume(jti, expiresAtSec, Date.now());
  }
}
