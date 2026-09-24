import type { QuestionSet } from "@proofline/questions";
import { AnswerValidationError, validateAnswers, type Answers } from "../types/answers.js";
import type { State } from "../types/state.js";
import { heuristicAnswers } from "./heuristics.js";

export type ProviderName = "jev" | "mock" | "rules";
export type DecisionSource = ProviderName | "fallback";

export interface DecideOptions {
  signal: AbortSignal;
}

export interface DecisionProvider {
  readonly name: ProviderName;
  /**
   * Answer every question in `askedKeys` for `state`. Implementations must
   * honour `opts.signal` and may throw; `withFallback` handles failures.
   */
  decide(state: State, set: QuestionSet, askedKeys: readonly string[], opts: DecideOptions): Promise<Answers>;
}

/** Questions that apply to this state (e.g. content checks only when there is text). */
export function askedQuestionKeys(state: State, set: QuestionSet): string[] {
  return set.questions.filter((q) => q.when === "always" || (q.when === "has_text" && !!state.text)).map((q) => q.key);
}

/** Deterministic provider for tests and local development without an API key. */
export class MockProvider implements DecisionProvider {
  readonly name = "mock" as const;
  constructor(private readonly opts: { delayMs?: number } = {}) {}

  async decide(state: State, set: QuestionSet, askedKeys: readonly string[], { signal }: DecideOptions) {
    if (this.opts.delayMs) await abortableDelay(this.opts.delayMs, signal);
    return heuristicAnswers(state, set, askedKeys, { maxConfidence: 0.99 });
  }
}

/**
 * Fallback when the model is unavailable. Uses the same heuristics but never
 * claims more than 0.6 confidence, so confidence-gated policy rules
 * (confident block, confident allow) don't fire on heuristics alone.
 */
export class RulesOnlyProvider implements DecisionProvider {
  readonly name = "rules" as const;
  static readonly MAX_CONFIDENCE = 0.6;

  async decide(state: State, set: QuestionSet, askedKeys: readonly string[]) {
    return heuristicAnswers(state, set, askedKeys, { maxConfidence: RulesOnlyProvider.MAX_CONFIDENCE });
  }
}

export interface DecisionResult {
  answers: Answers;
  source: DecisionSource;
  asked: string[];
  latency_ms: number;
  fallback_reason?: "timeout" | "error" | "invalid_response";
}

export interface WithFallbackOptions {
  timeoutMs: number;
  now?: () => number;
}

/**
 * Run `primary` with a hard timeout. On timeout, error or an answer that fails
 * validation, use `fallback` and record `source: "fallback"`. The fallback is
 * expected to be local and fast; if it throws, that error propagates.
 */
export async function decideWithFallback(
  primary: DecisionProvider,
  fallback: DecisionProvider,
  state: State,
  set: QuestionSet,
  opts: WithFallbackOptions,
): Promise<DecisionResult> {
  const now = opts.now ?? (() => performance.now());
  const start = now();
  const asked = askedQuestionKeys(state, set);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new DOMException("Decision provider timed out", "TimeoutError"));
      resolve("timeout");
    }, opts.timeoutMs);
  });

  let reason: DecisionResult["fallback_reason"];
  try {
    const raced = await Promise.race([
      primary.decide(state, set, asked, { signal: controller.signal }).then((a) => ({ answers: a })),
      timeout,
    ]);
    if (raced === "timeout") {
      reason = "timeout";
    } else {
      try {
        const answers = validateAnswers(raced.answers, set, asked);
        return { answers, source: primary.name, asked, latency_ms: now() - start };
      } catch {
        reason = "invalid_response";
      }
    }
  } catch (err) {
    reason = controller.signal.aborted ? "timeout" : err instanceof AnswerValidationError ? "invalid_response" : "error";
  } finally {
    clearTimeout(timer);
    if (!controller.signal.aborted) controller.abort();
  }

  const answers = await fallback.decide(state, set, asked, { signal: new AbortController().signal });
  return { answers, source: "fallback", asked, latency_ms: now() - start, fallback_reason: reason };
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
