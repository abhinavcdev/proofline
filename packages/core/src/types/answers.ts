import { z } from "zod";
import type { QuestionSet } from "@proofline/questions";

/**
 * Internal, provider-agnostic answer types. JevProvider maps Jev's wire format
 * into these; the rest of the system never sees wire field names.
 */

const Prob = z.number().min(0).max(1);
const SUM_TOLERANCE = 0.02;

export const NoulAnswer = z.object({
  type: z.literal("noul"),
  /** Probability of "yes". */
  p: Prob,
  confidence: Prob,
  /** True when the provider gave no confidence and we derived it as |2p − 1|. */
  confidence_derived: z.boolean(),
});

export const ChoiceAnswer = z.object({
  type: z.literal("choice"),
  label: z.string(),
  probs: z.record(z.string(), Prob),
  confidence: Prob,
});

export const ScoreAnswer = z.object({
  type: z.literal("score"),
  /** Most likely value on the legend. */
  value: z.number().int().min(0),
  /** probs[i] = probability of legend value i. */
  probs: z.array(Prob).min(2),
  confidence: Prob,
});

export const Answer = z.discriminatedUnion("type", [NoulAnswer, ChoiceAnswer, ScoreAnswer]);
export type NoulAnswer = z.infer<typeof NoulAnswer>;
export type ChoiceAnswer = z.infer<typeof ChoiceAnswer>;
export type ScoreAnswer = z.infer<typeof ScoreAnswer>;
export type Answer = z.infer<typeof Answer>;

export const Answers = z.record(z.string(), Answer);
export type Answers = z.infer<typeof Answers>;

export function deriveNoulConfidence(p: number): number {
  return Math.abs(2 * p - 1);
}

export class AnswerValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid answers: ${issues.join("; ")}`);
    this.name = "AnswerValidationError";
  }
}

/**
 * Validates answers against the asked questions: every asked key present with
 * the right type, labels/values within the question's options, distributions
 * summing to ~1. Throws AnswerValidationError.
 */
export function validateAnswers(raw: unknown, set: QuestionSet, askedKeys: readonly string[]): Answers {
  const parsed = Answers.safeParse(raw);
  if (!parsed.success) {
    throw new AnswerValidationError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  }
  const answers = parsed.data;
  const issues: string[] = [];

  for (const key of askedKeys) {
    const q = set.questions.find((x) => x.key === key);
    const a = answers[key];
    if (!q) {
      issues.push(`${key}: not in question set ${set.version}`);
      continue;
    }
    if (!a) {
      issues.push(`${key}: missing answer`);
      continue;
    }
    if (a.type !== q.type) {
      issues.push(`${key}: expected ${q.type}, got ${a.type}`);
      continue;
    }
    if (a.type === "choice" && q.type === "choice") {
      const labels = new Set(q.options.map((o) => o.label));
      if (!labels.has(a.label)) issues.push(`${key}: unknown label ${a.label}`);
      for (const l of Object.keys(a.probs)) if (!labels.has(l)) issues.push(`${key}: unknown label ${l} in probs`);
      const sum = Object.values(a.probs).reduce((s, p) => s + p, 0);
      if (Math.abs(sum - 1) > SUM_TOLERANCE) issues.push(`${key}: probabilities sum to ${sum.toFixed(3)}`);
    }
    if (a.type === "score" && q.type === "score") {
      if (a.probs.length !== q.legend.length) issues.push(`${key}: expected ${q.legend.length} probabilities`);
      if (a.value >= q.legend.length) issues.push(`${key}: value ${a.value} outside legend`);
      const sum = a.probs.reduce((s, p) => s + p, 0);
      if (Math.abs(sum - 1) > SUM_TOLERANCE) issues.push(`${key}: probabilities sum to ${sum.toFixed(3)}`);
    }
  }
  if (issues.length) throw new AnswerValidationError(issues);
  return answers;
}
