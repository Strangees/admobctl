import { OAuthTokenProvider, defaultSecretStore } from "./oauth.mjs";
import { AdcTokenProvider } from "./adc.mjs";

//#region src/core/auth/index.ts
/**
* Pick the credential source for a profile. `auto` (the default) uses gcloud ADC;
* `admobctl auth login` switches the profile to `oauth`.
*/
function resolveTokenProvider(profile, deps) {
	if (profile.authMode === "oauth") return new OAuthTokenProvider({
		profile: profile.name,
		store: deps.store ?? defaultSecretStore(deps.configDir, deps.exec),
		fetch: deps.fetch
	});
	return new AdcTokenProvider({ exec: deps.exec });
}

//#endregion
export { resolveTokenProvider };