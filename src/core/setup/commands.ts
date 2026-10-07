import type { Feature } from "./features.js";

/** Pin follow-up commands to the profile being diagnosed or configured. */
export function profileCommand(command: string, profile: string, configuredDefault = "default"): string {
  if (profile === "default" && configuredDefault === "default") return command;
  if (/--profile(?:[=\s]|$)/.test(command)) return command;
  const quoted = /^[A-Za-z0-9._-]+$/.test(profile) ? profile : `'${profile.replace(/'/g, "'\\''")}'`;
  return command.replace(/\badmobctl /, () => `admobctl --profile ${quoted} `);
}

/** The own-OAuth-client sign-in for these features; without `clientId` it reuses the profile's client and saved secret. */
export function oauthLoginCommand(features: Feature[], cloudPlatform: boolean, clientId?: string): string {
  const id = clientId === undefined ? "" : ` --client-id ${/^[A-Za-z0-9._-]+$/.test(clientId) ? clientId : `'${clientId.replace(/'/g, "'\\''")}'`}`;
  return `admobctl auth login${id}${features.includes("write") ? " --write" : ""}${features.includes("payments") ? " --payments" : ""}${cloudPlatform ? " --cloud-platform" : ""}`;
}

/**
 * The sign-in that adds cloud-platform (Cloud project and API setup) and keeps the features. gcloud's always asks for
 * it; an own OAuth client's `setup login` asks only once a quota project is set, so it gets the explicit `auth login`.
 */
export function cloudScopeFix(mode: "adc" | "oauth", features: Feature[]): string {
  return mode === "oauth" ? oauthLoginCommand(features, true) : "admobctl setup login --yes";
}
