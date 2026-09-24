import type { QuestionSetInput } from "./schema.js";

/**
 * Question set v1.
 *
 * Every question is evaluated against the same compact event summary
 * ("state") built by @proofline/core. Each asks one narrow thing, in plain
 * language, with explicit definitions so answers stay calibrated.
 *
 * Tuning: edit prompts/definitions here and bump to a new file (v2.ts) for any
 * change that alters meaning. Decisions record the version they were made with.
 */
export const v1 = {
  version: "v1",
  description: "Humanness + risk triage for signup, login, checkout, form_submit and comment events.",
  questions: [
    {
      key: "is_automated",
      type: "noul",
      prompt:
        "Was this event performed by software acting on its own (a script, headless browser, or bot) rather than by a person using the page directly? Judge only who operated the page, not whether the intent was good or bad.",
      definitions: {
        yes: "Software filled in and submitted the page without a person operating it in real time, including declared agents and browser automation.",
        no: "A person operated the page: typed or pasted, moved a pointer or tapped, and submitted it themselves, even if assisted by password managers or autofill.",
      },
      when: "always",
    },
    {
      key: "actor_type",
      type: "choice",
      prompt: "Which single description best fits whoever or whatever performed this event?",
      options: [
        {
          label: "human",
          definition: "A person using the site normally for themselves.",
        },
        {
          label: "declared_agent",
          definition:
            "Software that openly identifies itself (for example a signed agent header or a verified crawler) and acts within its stated purpose.",
        },
        {
          label: "scraper",
          definition: "Automation whose purpose is to read or copy site content or data, not to use the service.",
        },
        {
          label: "spam_bot",
          definition: "Automation that posts unwanted promotional, junk or link-dropping content.",
        },
        {
          label: "credential_stuffer",
          definition:
            "Automation trying many username and password combinations, usually from leaked lists, to break into existing accounts.",
        },
        {
          label: "farm_account",
          definition:
            "Accounts created in bulk (by scripts or paid human workers) to be used later for abuse, fake engagement or promotions.",
        },
      ],
      when: "always",
    },
    {
      key: "risk_level",
      type: "score",
      prompt:
        "If this event is allowed with no extra check, how much harm is it likely to cause the site or its users?",
      legend: [
        { value: 0, label: "safe", definition: "Ordinary activity; allowing it carries no meaningful risk." },
        { value: 1, label: "low", definition: "Slightly unusual, but harm is unlikely or would be minor." },
        {
          value: 2,
          label: "elevated",
          definition: "Several warning signs; allowing it could plausibly lead to abuse, fraud or account harm.",
        },
        {
          value: 3,
          label: "high",
          definition: "Strong evidence of abuse, fraud or account takeover; allowing it would likely cause harm.",
        },
      ],
      when: "always",
    },
    {
      key: "content_is_templated",
      type: "noul",
      prompt:
        "Does the free text in this event look mass-produced from a template or generator rather than written for this specific site and moment?",
      definitions: {
        yes: "Generic, reusable wording such as boilerplate promotions, spun text, keyword lists or messages that would fit any site unchanged.",
        no: "Text that is specific to this site, order or conversation, including short or informal messages.",
      },
      when: "has_text",
    },
    {
      key: "intent",
      type: "choice",
      prompt: "What is the most likely purpose of this event?",
      options: [
        { label: "normal_use", definition: "Using the site as intended: buying, signing up, logging in or getting in touch." },
        {
          label: "data_harvesting",
          definition: "Collecting content, prices, accounts or other data in bulk for use elsewhere.",
        },
        { label: "fraud", definition: "Obtaining money, goods or promotions dishonestly, for example with stolen cards." },
        { label: "spam", definition: "Delivering unwanted promotional or junk content to the site or its users." },
        {
          label: "account_takeover",
          definition: "Gaining access to an account that belongs to someone else.",
        },
      ],
      when: "always",
    },
  ],
} as const satisfies QuestionSetInput;
