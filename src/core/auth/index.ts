import type { ResolvedProfile } from "../config.js";
import type { Exec } from "../exec.js";
import { AdcTokenProvider } from "./adc.js";
import { defaultSecretStore, OAuthTokenProvider, type SecretStore } from "./oauth.js";
import type { TokenProvider } from "./types.js";

export interface AuthDeps {
  configDir: string;
  exec?: Exec;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  store?: SecretStore;
}

/**
 * Pick the credential source for a profile. `auto` (the default) uses gcloud ADC;
 * `admobctl auth login` switches the profile to `oauth`.
 */
export function resolveTokenProvider(profile: ResolvedProfile, deps: AuthDeps): TokenProvider {
  if (profile.authMode === "oauth") {
    return new OAuthTokenProvider({
      profile: profile.name,
      store: deps.store ?? defaultSecretStore(deps.configDir, deps.exec),
      fetch: deps.fetch,
      sleep: deps.sleep,
    });
  }
  return new AdcTokenProvider({ exec: deps.exec });
}
