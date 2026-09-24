/**
 * Identity verification (document + selfie) is a vendor integration. The MVP
 * ships the interface and a stub that always reports `unavailable`, so the
 * ladder falls through to manual review.
 */
export type IdVerifyStart = { status: "unavailable" } | { status: "started"; session_id: string; url: string };
export type IdVerifyResult = "verified" | "rejected" | "pending" | "unavailable";

export interface IdVerifier {
  start(input: { challenge_id: string; return_url?: string }): Promise<IdVerifyStart>;
  result(sessionId: string): Promise<IdVerifyResult>;
}

export class StubIdVerifier implements IdVerifier {
  async start(): Promise<IdVerifyStart> {
    return { status: "unavailable" };
  }
  async result(): Promise<IdVerifyResult> {
    return "unavailable";
  }
}
