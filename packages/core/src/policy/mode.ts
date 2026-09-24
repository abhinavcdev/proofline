import type { Mode } from "../types/events.js";
import type { FinalDecision, PolicyDecision } from "../types/policy.js";

/**
 * The single place where enforcement mode is applied. In shadow mode the
 * effective action is always `allow`; the policy's action is kept for
 * reporting ("would have blocked").
 */
export function applyMode(decision: PolicyDecision, mode: Mode): FinalDecision {
  return {
    ...decision,
    mode,
    effective_action: mode === "shadow" ? "allow" : decision.action,
  };
}
