import { AdmobctlError } from "../errors.js";
import type { Exec } from "../exec.js";

/** The only gcloud call setup makes: creating Application Default Credentials needs gcloud and a browser. */
export function loginArgs(scopes: string[]): string[] {
  return ["auth", "application-default", "login", `--scopes=${scopes.join(",")}`];
}

export function loginCommand(scopes: string[]): string {
  return `gcloud ${loginArgs(scopes).join(" ")}`;
}

export const GCLOUD_INSTALL_URL = "https://cloud.google.com/sdk/docs/install";

export async function gcloudInstalled(exec: Exec): Promise<boolean> {
  try {
    return (await exec("gcloud", ["--version"], { timeoutMs: 30_000 })).code === 0;
  } catch {
    return false;
  }
}

/** Runs the sign-in attached to this terminal, so gcloud can open the browser and print its prompts (on stderr). */
export async function runLogin(exec: Exec, scopes: string[]): Promise<void> {
  const r = await exec("gcloud", loginArgs(scopes), { interactive: true });
  if (r.code !== 0) {
    throw new AdmobctlError("AUTH_NO_CREDENTIALS", `The gcloud sign-in did not complete (exit code ${r.code}).`, {
      fix: "admobctl setup login --yes",
    });
  }
}
