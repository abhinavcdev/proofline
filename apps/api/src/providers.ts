import { JevProvider, MockProvider, RulesOnlyProvider, type DecisionProvider } from "@proofline/core";

export interface ProviderEnv {
  DECISION_PROVIDER?: string | undefined;
  TYPESAFE_API_KEY?: string | undefined;
  JEV_MODEL?: string | undefined;
  JEV_BASE_URL?: string | undefined;
}

/** `DECISION_PROVIDER` wins; otherwise Jev when a key is set, else the deterministic mock. */
export function selectProvider(env: ProviderEnv, fetchImpl?: typeof fetch): DecisionProvider {
  const choice = env.DECISION_PROVIDER ?? (env.TYPESAFE_API_KEY ? "jev" : "mock");
  switch (choice) {
    case "jev":
      if (!env.TYPESAFE_API_KEY) throw new Error("DECISION_PROVIDER=jev needs TYPESAFE_API_KEY");
      return new JevProvider({
        apiKey: env.TYPESAFE_API_KEY,
        ...(env.JEV_MODEL ? { model: env.JEV_MODEL } : {}),
        ...(env.JEV_BASE_URL ? { baseUrl: env.JEV_BASE_URL } : {}),
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
      });
    case "rules":
      return new RulesOnlyProvider();
    case "mock":
      return new MockProvider();
    default:
      throw new Error(`Unknown DECISION_PROVIDER: ${choice}`);
  }
}
