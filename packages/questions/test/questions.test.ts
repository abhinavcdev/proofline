import { describe, expect, it } from "vitest";
import { QuestionSet, getQuestionSet, listQuestionSetVersions } from "../src/index.js";

describe("question sets", () => {
  it("v1 validates and contains the required questions with the right types", () => {
    const set = getQuestionSet("v1");
    const byKey = Object.fromEntries(set.questions.map((q) => [q.key, q]));
    expect(byKey.is_automated?.type).toBe("noul");
    expect(byKey.actor_type?.type).toBe("choice");
    expect(byKey.risk_level?.type).toBe("score");
    expect(byKey.content_is_templated?.type).toBe("noul");
    expect(byKey.intent?.type).toBe("choice");
  });

  it("v1 choice options and score legend match the spec", () => {
    const set = getQuestionSet("v1");
    const actor = set.questions.find((q) => q.key === "actor_type");
    const intent = set.questions.find((q) => q.key === "intent");
    const risk = set.questions.find((q) => q.key === "risk_level");
    expect(actor?.type === "choice" && actor.options.map((o) => o.label)).toEqual([
      "human",
      "declared_agent",
      "scraper",
      "spam_bot",
      "credential_stuffer",
      "farm_account",
    ]);
    expect(intent?.type === "choice" && intent.options.map((o) => o.label)).toEqual([
      "normal_use",
      "data_harvesting",
      "fraud",
      "spam",
      "account_takeover",
    ]);
    expect(risk?.type === "score" && risk.legend.map((l) => `${l.value}=${l.label}`)).toEqual([
      "0=safe",
      "1=low",
      "2=elevated",
      "3=high",
    ]);
  });

  it("content_is_templated is only asked when the event has text", () => {
    const q = getQuestionSet("v1").questions.find((x) => x.key === "content_is_templated");
    expect(q?.when).toBe("has_text");
  });

  it("rejects duplicate keys and non-contiguous legends", () => {
    const base = getQuestionSet("v1");
    const dup = { ...base, questions: [...base.questions, base.questions[0]] };
    expect(QuestionSet.safeParse(dup).success).toBe(false);

    const badLegend = {
      version: "v9",
      description: "x",
      questions: [
        {
          key: "r",
          type: "score",
          prompt: "How risky is this event overall?",
          legend: [
            { value: 0, label: "a", definition: "zero" },
            { value: 2, label: "b", definition: "two" },
          ],
        },
      ],
    };
    expect(QuestionSet.safeParse(badLegend).success).toBe(false);
  });

  it("unknown versions throw and the registry lists v1", () => {
    expect(() => getQuestionSet("v0")).toThrow(/Unknown question set/);
    expect(listQuestionSetVersions()).toContain("v1");
  });
});
