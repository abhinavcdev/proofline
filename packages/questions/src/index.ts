import { QuestionSet } from "./schema.js";
import { v1 } from "./v1.js";

export * from "./schema.js";

const registry = {
  v1: QuestionSet.parse(v1),
} as const satisfies Record<string, QuestionSet>;

export type QuestionSetVersion = keyof typeof registry;
export const LATEST_QUESTION_SET: QuestionSetVersion = "v1";

export function getQuestionSet(version: string = LATEST_QUESTION_SET): QuestionSet {
  const set = (registry as Record<string, QuestionSet | undefined>)[version];
  if (!set) throw new Error(`Unknown question set version: ${version}`);
  return set;
}

export function listQuestionSetVersions(): QuestionSetVersion[] {
  return Object.keys(registry) as QuestionSetVersion[];
}

/** v1 option labels as literal types, for code that reasons about specific answers. */
export const ACTOR_TYPES = v1.questions[1].options.map((o) => o.label);
export type ActorType = (typeof v1.questions)[1]["options"][number]["label"];
export type Intent = (typeof v1.questions)[4]["options"][number]["label"];
