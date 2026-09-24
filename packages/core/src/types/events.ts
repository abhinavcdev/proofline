import { z } from "zod";

export const EventType = z.enum(["signup", "login", "checkout", "form_submit", "comment"]);
export type EventType = z.infer<typeof EventType>;

/** Event types whose free text is relevant for content checks. */
export const TEXT_EVENT_TYPES: ReadonlySet<EventType> = new Set(["form_submit", "comment"]);

/**
 * Step-up ladder, lowest friction first. Rung 0 ("invisible") is plain allow
 * and is not a challenge, so it's not listed here.
 */
export const Rung = z.enum(["pow", "passkey", "email_otp", "id_verify", "review"]);
export type Rung = z.infer<typeof Rung>;
export const LADDER: readonly Rung[] = Rung.options;

export const BaseAction = z.enum(["allow", "block", "shadow_drop", "agent_lane"]);
export type BaseAction = z.infer<typeof BaseAction>;

export type StepUpAction = `step_up:${Rung}`;
export type Action = BaseAction | StepUpAction;

export const Action = z.union([
  BaseAction,
  z.templateLiteral(["step_up:", Rung]),
]) as z.ZodType<Action>;

export const Mode = z.enum(["shadow", "enforce"]);
export type Mode = z.infer<typeof Mode>;

export function stepUp(rung: Rung): StepUpAction {
  return `step_up:${rung}`;
}

export function rungOf(action: Action): Rung | undefined {
  return action.startsWith("step_up:") ? (action.slice("step_up:".length) as Rung) : undefined;
}
