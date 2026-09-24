import { base64url, fromBase64url } from "@proofline/core";

/**
 * Web Bot Auth: agents sign requests with HTTP Message Signatures (RFC 9421)
 * using Ed25519, name their key directory in `Signature-Agent`, and tag the
 * signature `web-bot-auth`. We verify against an allowlist of directories:
 *
 *   Signature-Agent: "https://agent.example"
 *   Signature-Input: sig1=("@authority" "signature-agent");created=…;expires=…;keyid="<JWK thumbprint>";alg="ed25519";tag="web-bot-auth"
 *   Signature: sig1=:<base64>:
 *
 * The key directory is fetched from
 * `<origin>/.well-known/http-message-signatures-directory` (a JWKS), and `keyid`
 * is the key's RFC 7638 SHA-256 thumbprint.
 */

export const WEB_BOT_AUTH_TAG = "web-bot-auth";
export const KEY_DIRECTORY_PATH = "/.well-known/http-message-signatures-directory";
const MAX_VALIDITY_S = 24 * 3600;
const CLOCK_SKEW_S = 60;

export interface TrustedAgent {
  /** Short name recorded in decisions, e.g. "example-shopping-agent". */
  name: string;
  /** Origin of the agent's key directory, e.g. "https://agent.example". */
  directory: string;
}

export type AgentVerification =
  | { status: "verified"; name: string }
  | { status: "unverified_claim"; reason: string }
  | { status: "none" };

interface Jwk {
  kty: string;
  crv?: string;
  x?: string;
}

/** RFC 7638 thumbprint for an OKP key. */
export async function jwkThumbprint(jwk: { crv: string; kty: string; x: string }): Promise<string> {
  const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}"}`;
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical))));
}

/** Split a structured-field dictionary into raw member strings, respecting quotes and parens. */
export function splitDictionary(value: string): Map<string, string> {
  const out = new Map<string, string>();
  let depth = 0;
  let quoted = false;
  let startIdx = 0;
  const push = (end: number) => {
    const member = value.slice(startIdx, end).trim();
    const eq = member.indexOf("=");
    if (eq > 0) out.set(member.slice(0, eq).trim(), member.slice(eq + 1).trim());
  };
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quoted) {
      if (ch === "\\") i++;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      push(i);
      startIdx = i + 1;
    }
  }
  push(value.length);
  return out;
}

interface SignatureParams {
  components: string[];
  params: Record<string, string | number>;
  /** The serialised inner list with parameters, used verbatim as `@signature-params`. */
  raw: string;
}

export function parseSignatureInput(raw: string): SignatureParams | null {
  const m = /^\(([^)]*)\)(.*)$/.exec(raw.trim());
  if (!m) return null;
  const components = [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!.toLowerCase());
  const params: Record<string, string | number> = {};
  for (const p of m[2]!.split(";").slice(1)) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    const k = p.slice(0, eq).trim();
    const v = p.slice(eq + 1).trim();
    params[k] = v.startsWith('"') ? v.slice(1, -1) : Number(v);
  }
  return { components, params, raw: raw.trim() };
}

function componentValue(name: string, request: Request): string | null {
  const url = new URL(request.url);
  switch (name) {
    case "@authority":
      return url.host.toLowerCase();
    case "@method":
      return request.method.toUpperCase();
    case "@path":
      return url.pathname;
    case "@query":
      return url.search || "?";
    case "@scheme":
      return url.protocol.replace(":", "");
    case "@target-uri":
      return url.href;
    default: {
      if (name.startsWith("@")) return null;
      const v = request.headers.get(name);
      return v === null ? null : v.trim();
    }
  }
}

export function signatureBase(request: Request, sig: SignatureParams): string | null {
  const lines: string[] = [];
  for (const c of sig.components) {
    const v = componentValue(c, request);
    if (v === null) return null;
    lines.push(`"${c}": ${v}`);
  }
  lines.push(`"@signature-params": ${sig.raw}`);
  return lines.join("\n");
}

/** Agent names that commonly appear in user agents without any signature. */
const AGENT_UA =
  /(GPTBot|ChatGPT-User|OAI-SearchBot|ClaudeBot|Claude-User|Claude-SearchBot|PerplexityBot|Perplexity-User|Googlebot|Google-Extended|bingbot|Applebot|Amazonbot|meta-externalagent|Bytespider|DuckAssistBot)/i;

export interface WebBotAuthOptions {
  trusted: readonly TrustedAgent[];
  fetch?: typeof fetch;
  now?: () => number;
  /** Key directory cache lifetime. */
  cacheTtlMs?: number;
}

export class WebBotAuthVerifier {
  readonly #trusted: Map<string, TrustedAgent>;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #ttl: number;
  readonly #cache = new Map<string, { at: number; keys: Map<string, CryptoKey> }>();

  constructor(opts: WebBotAuthOptions) {
    this.#trusted = new Map(opts.trusted.map((t) => [new URL(t.directory).origin, t]));
    this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.#now = opts.now ?? Date.now;
    this.#ttl = opts.cacheTtlMs ?? 3_600_000;
  }

  /**
   * `verified` only for a valid, current web-bot-auth signature from an allowlisted
   * directory. Signature headers that fail, or an agent-looking user agent with no
   * signature, count as `unverified_claim`.
   */
  async verify(request: Request): Promise<AgentVerification> {
    const sigInput = request.headers.get("signature-input");
    const sigHeader = request.headers.get("signature");
    const agentHeader = request.headers.get("signature-agent");
    if (!sigInput || !sigHeader) {
      if (agentHeader) return { status: "unverified_claim", reason: "signature_missing" };
      return AGENT_UA.test(request.headers.get("user-agent") ?? "")
        ? { status: "unverified_claim", reason: "unsigned_agent_user_agent" }
        : { status: "none" };
    }
    try {
      return await this.#verifySigned(request, sigInput, sigHeader, agentHeader);
    } catch {
      return { status: "unverified_claim", reason: "verification_error" };
    }
  }

  async #verifySigned(
    request: Request,
    sigInput: string,
    sigHeader: string,
    agentHeader: string | null,
  ): Promise<AgentVerification> {
    const fail = (reason: string): AgentVerification => ({ status: "unverified_claim", reason });
    const inputs = splitDictionary(sigInput);
    const sigs = splitDictionary(sigHeader);

    for (const [label, rawInput] of inputs) {
      const parsed = parseSignatureInput(rawInput);
      if (!parsed || parsed.params.tag !== WEB_BOT_AUTH_TAG) continue;
      const { params, components } = parsed;

      const nowS = Math.floor(this.#now() / 1000);
      const created = typeof params.created === "number" ? params.created : NaN;
      const expires = typeof params.expires === "number" ? params.expires : NaN;
      if (!Number.isFinite(created) || !Number.isFinite(expires)) return fail("missing_created_or_expires");
      if (created > nowS + CLOCK_SKEW_S || expires <= nowS || expires - created > MAX_VALIDITY_S) return fail("expired");
      if (!components.includes("@authority")) return fail("authority_not_signed");
      if (agentHeader && !components.includes("signature-agent")) return fail("agent_header_not_signed");
      if (params.alg !== undefined && params.alg !== "ed25519") return fail("unsupported_alg");

      const directory = this.#directoryOf(agentHeader);
      if (!directory) return fail("directory_not_trusted");
      const trusted = this.#trusted.get(directory)!;

      const keyid = typeof params.keyid === "string" ? params.keyid : "";
      const key = (await this.#keys(directory)).get(keyid);
      if (!key) return fail("unknown_key");

      const sigRaw = sigs.get(label);
      const sigMatch = sigRaw ? /^:([A-Za-z0-9+/=]+):$/.exec(sigRaw) : null;
      if (!sigMatch) return fail("signature_missing");
      const sigBytes = Uint8Array.from(atob(sigMatch[1]!), (c) => c.charCodeAt(0));

      const base = signatureBase(request, parsed);
      if (base === null) return fail("component_missing");
      const ok = await crypto.subtle.verify("Ed25519", key, sigBytes, new TextEncoder().encode(base));
      return ok ? { status: "verified", name: trusted.name } : fail("bad_signature");
    }
    return fail("no_web_bot_auth_signature");
  }

  #directoryOf(agentHeader: string | null): string | null {
    if (!agentHeader) return null;
    // Either an sf-string ("https://…") or a dictionary member (label="https://…").
    const m = /"(https:\/\/[^"]+)"/.exec(agentHeader);
    if (!m) return null;
    try {
      const origin = new URL(m[1]!).origin;
      return this.#trusted.has(origin) ? origin : null;
    } catch {
      return null;
    }
  }

  async #keys(origin: string): Promise<Map<string, CryptoKey>> {
    const cached = this.#cache.get(origin);
    if (cached && this.#now() - cached.at < this.#ttl) return cached.keys;
    const res = await this.#fetch(`${origin}${KEY_DIRECTORY_PATH}`, {
      headers: { accept: "application/http-message-signatures-directory+json, application/json" },
    });
    if (!res.ok) throw new Error(`key directory HTTP ${res.status}`);
    const body = (await res.json()) as { keys?: Jwk[] };
    const keys = new Map<string, CryptoKey>();
    for (const jwk of body.keys ?? []) {
      if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") continue;
      fromBase64url(jwk.x); // throws on junk
      const thumb = await jwkThumbprint({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
      keys.set(thumb, await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: jwk.x }, { name: "Ed25519" }, false, ["verify"]));
    }
    this.#cache.set(origin, { at: this.#now(), keys });
    return keys;
  }
}

/**
 * Sign a request as a Web Bot Auth agent. Used by tests and the bot-sim
 * `polite-agent` profile; real agents use their own tooling.
 */
export async function signWebBotAuth(
  request: Request,
  opts: { privateKey: CryptoKey; keyid: string; agentOrigin: string; nowMs?: number; ttlS?: number },
): Promise<Request> {
  const created = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  const headers = new Headers(request.headers);
  headers.set("signature-agent", `"${opts.agentOrigin}"`);
  const raw = `("@authority" "signature-agent");created=${created};expires=${created + (opts.ttlS ?? 300)};keyid="${opts.keyid}";alg="ed25519";tag="${WEB_BOT_AUTH_TAG}"`;
  const signed = new Request(request, { headers });
  const base = signatureBase(signed, parseSignatureInput(raw)!)!;
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", opts.privateKey, new TextEncoder().encode(base)));
  headers.set("signature-input", `sig1=${raw}`);
  headers.set("signature", `sig1=:${btoa(String.fromCharCode(...sig))}:`);
  return new Request(request, { headers });
}
