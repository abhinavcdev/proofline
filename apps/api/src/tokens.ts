import { z } from "zod";
import { BrowserSignals, EdgeSignals, EventType, PowStatus } from "@proofline/core";

/** Signal token: browser + edge signals, bound to project, event type and origin. */
export const SIGNAL_TOKEN_TYPE = "sig";
export const SIGNAL_TOKEN_TTL_S = 300;

export const SignalTokenData = z.object({
  p: z.string(),
  e: EventType,
  o: z.string().max(256),
  b: BrowserSignals,
  g: EdgeSignals,
  rl: z.array(z.enum(["ip", "asn", "fingerprint"])),
  pw: PowStatus,
});
export type SignalTokenData = z.infer<typeof SignalTokenData>;
