import { z } from "zod";
import type { Question, QuestionSet } from "@proofline/questions";
import { AnswerValidationError, deriveNoulConfidence, type Answer, type Answers } from "../types/answers.js";
import type { State } from "../types/state.js";
import type { DecideOptions, DecisionProvider } from "./provider.js";

/**
 * Jev (TypeSafe AI) client.
 *
 * The HTTP wire format lives in a `JevWire` adapter so the provider's
 * behaviour (timeouts, auth, error handling) is independent of field names.
 * `TYPESAFE_WIRE` implements the documented System One API; see
 * docs/vendor/typesafe-jev.md.
 */
export interface JevWire {
  /** Path relative to the base URL. */
  readonly path: string;
  buildBody(state: State, set: QuestionSet, askedKeys: readonly string[], model: string): unknown;
  /** Validate the raw JSON (Zod) and map it to internal Answers. */
  parseResponse(json: unknown, set: QuestionSet, askedKeys: readonly string[]): Answers;
  /** Request headers carrying the API key. */
  authHeaders(apiKey: string): Record<string, string>;
}

export const JEV_DEFAULT_BASE_URL = "https://api.typesafe.ai";
export const JEV_DEFAULT_MODEL = "jev-latest";

/** One Jev question, built from our question definition. */
function toWireQuestion(q: Question): unknown {
  switch (q.type) {
    case "noul":
      return { type: "noul", instructions: q.prompt, criteria: { true: q.definitions.yes, false: q.definitions.no } };
    case "choice":
      return {
        type: "choice",
        instructions: q.prompt,
        criteria: Object.fromEntries(q.options.map((o) => [o.label, o.definition])),
      };
    case "score":
      // Levels are ordered; index i in `criteria` is legend value i.
      return { type: "score", instructions: q.prompt, criteria: q.legend.map((l) => `${l.label}: ${l.definition}`) };
  }
}

const Prob = z.number().min(0).max(1);
const WireAnswer = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: Prob }),
  z.object({ type: z.literal("choice"), choice: z.string(), probabilities: z.record(z.string(), Prob), confidence: Prob }),
  z.object({
    type: z.literal("score"),
    score: z.number(),
    probabilities: z.record(z.string(), Prob),
    confidence: Prob,
  }),
]);
const WireResponse = z.object({
  model: z.string(),
  answers: z.record(z.string(), WireAnswer),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).partial().optional(),
});

function fromWireAnswer(key: string, q: Question, a: z.infer<typeof WireAnswer>): Answer {
  if (a.type === "noul") {
    // Jev returns no confidence for nouls (Q2): derive it from the probability.
    return { type: "noul", p: a.noul, confidence: deriveNoulConfidence(a.noul), confidence_derived: true };
  }
  if (a.type === "choice") return { type: "choice", label: a.choice, probs: a.probabilities, confidence: a.confidence };
  if (q.type !== "score") throw new AnswerValidationError([`${key}: expected ${q.type}, got score`]);
  const probs = q.legend.map((_, i) => a.probabilities[String(i)] ?? 0);
  // Internal `value` is the most likely level; Jev's `score` is the expectation.
  let value = 0;
  probs.forEach((p, i) => {
    if (p > (probs[value] ?? 0)) value = i;
  });
  return { type: "score", value, probs, confidence: a.confidence };
}

/** The documented System One wire format: POST /v1/systemone, bearer auth. */
export const TYPESAFE_WIRE: JevWire = {
  path: "/v1/systemone",
  buildBody(state, set, askedKeys, model) {
    const questions: Record<string, unknown> = {};
    for (const key of askedKeys) {
      const q = set.questions.find((x) => x.key === key);
      if (q) questions[key] = toWireQuestion(q);
    }
    return { model, state, questions };
  },
  parseResponse(json, set, askedKeys) {
    const parsed = WireResponse.safeParse(json);
    if (!parsed.success) {
      throw new AnswerValidationError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
    }
    const out: Answers = {};
    for (const key of askedKeys) {
      const q = set.questions.find((x) => x.key === key);
      const a = parsed.data.answers[key];
      if (q && a) {
        if (a.type !== q.type) throw new AnswerValidationError([`${key}: expected ${q.type}, got ${a.type}`]);
        out[key] = fromWireAnswer(key, q, a);
      }
    }
    return out;
  },
  authHeaders(apiKey) {
    return { authorization: `Bearer ${apiKey}` };
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
  /** Defaults to https://api.typesafe.ai. */
  baseUrl?: string;
  /** `jev-latest` by default; pin a versioned id (e.g. `jev-1.13.0`) once thresholds are tuned. */
  model?: string;
  wire?: JevWire;
  fetch?: typeof fetch;
}

export class JevProvider implements DecisionProvider {
  readonly name = "jev" as const;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #wire: JevWire;
  readonly #model: string;
  readonly #fetch: typeof fetch;

  constructor(opts: JevProviderOptions) {
    if (!opts.apiKey) throw new Error("JevProvider requires an API key");
    this.#apiKey = opts.apiKey;
    this.#baseUrl = (opts.baseUrl ?? JEV_DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#model = opts.model ?? JEV_DEFAULT_MODEL;
    this.#wire = opts.wire ?? TYPESAFE_WIRE;
    this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async decide(state: State, set: QuestionSet, askedKeys: readonly string[], { signal }: DecideOptions): Promise<Answers> {
    const body = this.#wire.buildBody(state, set, askedKeys, this.#model);
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
    return { name: this.name, baseUrl: this.#baseUrl, model: this.#model };
  }
}
