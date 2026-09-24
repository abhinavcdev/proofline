import type { EventType } from "../types/events.js";
import { EventPolicy, type Rule } from "../types/policy.js";

/**
 * Default policies. Projects start from these and tune thresholds per event
 * type in the dashboard. Rules are evaluated in order; first match wins.
 */

const blockConfidentAutomation: Rule = {
  id: "block_confident_automation",
  when: [
    { type: "prob", q: "is_automated", op: "gt", value: 0.9 },
    { type: "confidence", q: "is_automated", op: "gte", value: 0.9 },
  ],
  then: { action: "block" },
  explain: "Very likely automated, with high confidence",
};

const allowConfidentHuman: Rule = {
  id: "allow_confident_human",
  when: [
    { type: "prob", q: "is_automated", op: "lt", value: 0.2 },
    { type: "confidence", q: "is_automated", op: "gte", value: 0.8 },
    { type: "score", q: "risk_level", op: "lt", value: 2 },
  ],
  then: { action: "allow" },
  explain: "Very likely a person, with high confidence and low risk",
};

const stepUpUncertainRisk: Rule = {
  id: "step_up_uncertain_risk",
  when: [
    { type: "score", q: "risk_level", op: "gte", value: 2 },
    { type: "confidence", q: "risk_level", op: "lt", value: 0.7 },
  ],
  then: { action: "step_up", level: 1 },
  explain: "Elevated risk but the assessment is uncertain; a light check resolves it",
};

const eventRules: Record<EventType, Rule[]> = {
  signup: [
    {
      id: "farm_account_signup",
      when: [
        { type: "label", q: "actor_type", in: ["farm_account"] },
        { type: "confidence", q: "actor_type", op: "gte", value: 0.7 },
      ],
      then: { action: "step_up", rung: "email_otp" },
      explain: "Looks like bulk account creation; confirm the email address",
    },
  ],
  login: [
    {
      id: "credential_stuffing",
      when: [
        { type: "label", q: "actor_type", in: ["credential_stuffer"] },
        { type: "confidence", q: "actor_type", op: "gte", value: 0.7 },
      ],
      then: { action: "step_up", level: 2 },
      explain: "Looks like credential stuffing; confirm with a passkey or one-time code",
    },
  ],
  checkout: [
    {
      id: "checkout_fraud",
      when: [
        { type: "label", q: "intent", in: ["fraud"] },
        { type: "confidence", q: "intent", op: "gte", value: 0.7 },
      ],
      then: { action: "step_up", level: 2 },
      explain: "Signs of payment fraud; confirm the buyer before charging",
    },
  ],
  form_submit: [],
  comment: [],
};

const spamRules: Rule[] = [
  {
    id: "drop_confident_spam",
    when: [
      { type: "label", q: "actor_type", in: ["spam_bot"] },
      { type: "confidence", q: "actor_type", op: "gte", value: 0.8 },
    ],
    then: { action: "shadow_drop" },
    explain: "Automated spam; accepted silently and discarded",
  },
  {
    id: "drop_templated_automated_text",
    when: [
      { type: "prob", q: "content_is_templated", op: "gt", value: 0.9 },
      { type: "prob", q: "is_automated", op: "gt", value: 0.6 },
    ],
    then: { action: "shadow_drop" },
    explain: "Boilerplate text posted by likely automation; accepted silently and discarded",
  },
];

export function defaultPolicy(eventType: EventType): EventPolicy {
  const textRules = eventType === "comment" || eventType === "form_submit" ? spamRules : [];
  return EventPolicy.parse({
    version: 1,
    event_type: eventType,
    // Spam rules come first: on text events a silent drop beats a block that tells the sender they were caught.
    rules: [...textRules, blockConfidentAutomation, ...eventRules[eventType], allowConfidentHuman, stepUpUncertainRisk],
    default_by_risk: [
      { action: "allow" },
      { action: "allow" },
      { action: "step_up", level: 1 },
      { action: "step_up", level: 2 },
    ],
    missing_token: { action: "step_up", rung: "pow" },
    declared_agent: { action: "agent_lane" },
  });
}
