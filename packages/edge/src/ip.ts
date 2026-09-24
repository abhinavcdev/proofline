import { hmacSha256 } from "@proofline/core";

/**
 * IP handling. Raw IPs are used only in memory, for list lookups and hashing,
 * and are never stored or sent to the model.
 *
 *   daily_salt = HMAC(IP_SALT_SECRET, yyyy-mm-dd)   (UTC)
 *   ip_hash    = HMAC(daily_salt, ip)[0..16] as hex
 *
 * This supports correlation within a day but not across days.
 */

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export async function dailySalt(saltSecret: string, nowMs: number): Promise<string> {
  return hex(await hmacSha256(saltSecret, `ip-salt:${utcDay(nowMs)}`));
}

export async function hashIp(ip: string, saltSecret: string, nowMs: number = Date.now()): Promise<string> {
  const salt = await dailySalt(saltSecret, nowMs);
  return hex((await hmacSha256(salt, normalizeIp(ip) ?? ip)).slice(0, 16));
}

/** Canonical text form (lowercase, IPv4-mapped IPv6 unwrapped), or null if not an IP. */
export function normalizeIp(ip: string): string | null {
  const s = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped) return parseV4(mapped[1]!) === null ? null : mapped[1]!;
  if (parseV4(s) !== null) return s;
  const v6 = parseV6(s);
  if (v6 === null) return null;
  return v6.toString(16).padStart(32, "0").replace(/(.{4})(?!$)/g, "$1:");
}

function parseV4(s: string): bigint | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = (n << 8n) | BigInt(p);
  }
  return n;
}

function parseV6(s: string): bigint | null {
  if (!/^[0-9a-f:.]+$/.test(s) || s.split("::").length > 2) return null;
  let tail = s;
  let v4: bigint | null = null;
  const lastColon = s.lastIndexOf(":");
  if (s.includes(".")) {
    v4 = parseV4(s.slice(lastColon + 1));
    if (v4 === null) return null;
    tail = s.slice(0, lastColon + 1) + "0:0";
  }
  const [head, rest] = tail.split("::") as [string, string | undefined];
  const h = head ? head.split(":") : [];
  const r = rest !== undefined && rest !== "" ? rest.split(":") : [];
  const missing = 8 - h.length - r.length;
  if ((rest === undefined && missing !== 0) || missing < 0) return null;
  const groups = [...h, ...Array<string>(rest === undefined ? 0 : missing).fill("0"), ...r];
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  if (v4 !== null) n = (n & ~0xffffffffn) | v4;
  return n;
}

function parseAny(ip: string): { v: 4 | 6; n: bigint } | null {
  const norm = normalizeIp(ip);
  if (!norm) return null;
  const v4 = parseV4(norm);
  if (v4 !== null) return { v: 4, n: v4 };
  const v6 = parseV6(norm);
  return v6 === null ? null : { v: 6, n: v6 };
}

/** Reputation source for known-bad IPs (abuse feeds, customer blocklists). */
export interface IpReputation {
  isBad(ip: string): boolean | Promise<boolean>;
}

/** CIDR blocklist (IPv4 and IPv6). */
export class StaticIpList implements IpReputation {
  readonly #ranges: Array<{ v: 4 | 6; net: bigint; mask: bigint }> = [];

  constructor(cidrs: readonly string[]) {
    for (const c of cidrs) {
      const [addr, len] = c.split("/") as [string, string | undefined];
      const p = parseAny(addr);
      if (!p) throw new Error(`Invalid CIDR: ${c}`);
      const bits = p.v === 4 ? 32 : 128;
      const prefix = len === undefined ? bits : Number(len);
      if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) throw new Error(`Invalid CIDR: ${c}`);
      const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(bits - prefix);
      this.#ranges.push({ v: p.v, net: p.n & mask, mask });
    }
  }

  isBad(ip: string): boolean {
    const p = parseAny(ip);
    if (!p) return false;
    return this.#ranges.some((r) => r.v === p.v && (p.n & r.mask) === r.net);
  }
}

export const EMPTY_IP_LIST: IpReputation = { isBad: () => false };
