import type { QuestionSet } from "@proofline/questions";
import type { Answers } from "../types/answers.js";
import type { State } from "../types/state.js";
import type { DecideOptions, DecisionProvider } from "./provider.js";

/**
 * Jev (TypeSafe AI) client.
 *
 * The HTTP wire format lives in a `JevWire` adapter so the provider's
 * behaviour (timeouts, auth, error handling) is independent of field names.
 *
 * STATUS: the real wire schema has not been implemented yet because
 * https://docs.typesafe.ai was unreachable from the build environment
 * (PLAN.md Q1). `PENDING_JEV_WIRE` refuses to build a request, so JevProvider
 * fails fast and `decideWithFallback` degrades to rules. Do not guess field
 * names: implement `JevWire` from the documented request/response schema,
 * with Zod validation of the response.
 */
export interface JevWire {
  /** Path relative to the base URL, e.g. the documented evaluate endpoint. */
  readonly path: string;
  buildBody(state: State, set: QuestionSet, askedKeys: readonly string[]): unknown;
  /** Validate the raw JSON (Zod) and map it to internal Answers. */
  parseResponse(json: unknown, set: QuestionSet, askedKeys: readonly string[]): Answers;
  /** Request headers carrying the API key, per the documented auth scheme. */
  authHeaders(apiKey: string): Record<string, string>;
}

export class JevWireUnavailableError extends Error {
  constructor() {
    super("Jev wire schema not implemented; see PLAN.md Q1");
    this.name = "JevWireUnavailableError";
  }
}

export const PENDING_JEV_WIRE: JevWire = {
  path: "",
  buildBody() {
    throw new JevWireUnavailableError();
  },
  parseResponse() {
    throw new JevWireUnavailableError();
  },
  authHeaders() {
    throw new JevWireUnavailableError();
  },
};

export class JevHttpError extends Error {
  constructor(public readonly status: number) {
    super(`Jev request failed with HTTP ${status}`);
    this.name = "JevHttpError";
  }
}

export interface JevProviderOptions {
  /** From env.TYPESAFE_API_KEY. Never logged. */
  apiKey: string;
  baseUrl: string;
  wire?: JevWire;
  fetch?: typeof fetch;
}

export class JevProvider implements DecisionProvider {
  readonly name = "jev" as const;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #wire: JevWire;
  readonly #fetch: typeof fetch;

  constructor(opts: JevProviderOptions) {
    if (!opts.apiKey) throw new Error("JevProvider requires an API key");
    this.#apiKey = opts.apiKey;
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.#wire = opts.wire ?? PENDING_JEV_WIRE;
    this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async decide(state: State, set: QuestionSet, askedKeys: readonly string[], { signal }: DecideOptions): Promise<Answers> {
    const body = this.#wire.buildBody(state, set, askedKeys);
    const res = await this.#fetch(`${this.#baseUrl}${this.#wire.path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...this.#wire.authHeaders(this.#apiKey) },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw new JevHttpError(res.status);
    return this.#wire.parseResponse(await res.json(), set, askedKeys);
  }

  /** Keep the key out of accidental serialisation/logging. */
  toJSON() {
    return { name: this.name, baseUrl: this.#baseUrl };
  }
}
