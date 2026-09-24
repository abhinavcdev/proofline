import { z } from "zod";

/**
 * A question set is plain data so it can be versioned, stored per project,
 * and tuned without code changes. `when` is an enum (not a function) for the
 * same reason.
 */

const Key = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,39}$/, "question keys are snake_case, max 40 chars");

const Prompt = z.string().min(10).max(600);
const Definition = z.string().min(3).max(300);

export const QuestionWhen = z.enum(["always", "has_text"]);
export type QuestionWhen = z.infer<typeof QuestionWhen>;

export const NoulQuestion = z.object({
  key: Key,
  type: z.literal("noul"),
  prompt: Prompt,
  definitions: z.object({ yes: Definition, no: Definition }),
  when: QuestionWhen.default("always"),
});

export const ChoiceQuestion = z.object({
  key: Key,
  type: z.literal("choice"),
  prompt: Prompt,
  options: z
    .array(z.object({ label: Key, definition: Definition }))
    .min(2)
    .max(12)
    .refine((opts) => new Set(opts.map((o) => o.label)).size === opts.length, {
      message: "choice labels must be unique",
    }),
  when: QuestionWhen.default("always"),
});

export const ScoreQuestion = z.object({
  key: Key,
  type: z.literal("score"),
  prompt: Prompt,
  legend: z
    .array(z.object({ value: z.number().int().min(0), label: z.string().min(1), definition: Definition }))
    .min(2)
    .max(11)
    .refine((legend) => legend.every((l, i) => l.value === i), {
      message: "score legend values must be contiguous and start at 0",
    }),
  when: QuestionWhen.default("always"),
});

export const Question = z.discriminatedUnion("type", [NoulQuestion, ChoiceQuestion, ScoreQuestion]);
export type Question = z.infer<typeof Question>;
export type NoulQuestion = z.infer<typeof NoulQuestion>;
export type ChoiceQuestion = z.infer<typeof ChoiceQuestion>;
export type ScoreQuestion = z.infer<typeof ScoreQuestion>;
export type QuestionType = Question["type"];

export const QuestionSet = z
  .object({
    version: z.string().regex(/^v\d+(\.\d+)?$/),
    description: z.string().max(500),
    questions: z.array(Question).min(1).max(16),
  })
  .refine((set) => new Set(set.questions.map((q) => q.key)).size === set.questions.length, {
    message: "question keys must be unique within a set",
  });
export type QuestionSet = z.infer<typeof QuestionSet>;
export type QuestionSetInput = z.input<typeof QuestionSet>;
