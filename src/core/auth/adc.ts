import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AdmobctlError } from "../errors.js";
import { exec as defaultExec, type Exec } from "../exec.js";
import type { TokenProvider } from "./types.js";

export interface AdcInfo {
  path: string;
  /** authorized_user | service_account | external_account | impersonated_service_account */
  type?: string;
  quotaProjectId?: string;
}

export function adcPath(env: NodeJS.ProcessEnv = process.env, platform = process.platform, home = homedir()): string {
  if (env.GOOGLE_APPLICATION_CREDENTIALS) return env.GOOGLE_APPLICATION_CREDENTIALS;
  const file = "application_default_credentials.json";
  if (env.CLOUDSDK_CONFIG) return join(env.CLOUDSDK_CONFIG, file);
  if (platform === "win32") return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "gcloud", file);
  return join(home, ".config", "gcloud", file);
}

/** Read only the non-secret fields of the ADC file. */
export function readAdcInfo(path = adcPath(), read: (p: string) => string = (p) => readFileSync(p, "utf8")): AdcInfo | undefined {
  let raw: string;
  try {
    raw = read(path);
  } catch {
    return undefined;
  }
  try {
    const j = JSON.parse(raw) as { type?: string; quota_project_id?: string };
    const info: AdcInfo = { path };
    if (j.type) info.type = j.type;
    if (j.quota_project_id) info.quotaProjectId = j.quota_project_id;
    return info;
  } catch {
    return { path };
  }
}

const TOKEN_TTL_MS = 45 * 60 * 1000;

const UNSET_FIX = "Unset GOOGLE_APPLICATION_CREDENTIALS in the terminal that runs admobctl, then run admobctl setup login --yes.";

export interface AdcDeps {
  info?: () => AdcInfo | undefined;
  env?: NodeJS.ProcessEnv;
  exec?: Exec;
  now?: () => number;
}

/**
 * Access tokens from gcloud Application Default Credentials. We delegate token
 * refresh to gcloud so we never read or store the refresh token ourselves.
 */
export class AdcTokenProvider implements TokenProvider {
  readonly mode = "adc" as const;
  private cached?: { token: string; at: number };
  private readonly info: () => AdcInfo | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly exec: Exec;
  private readonly now: () => number;

  constructor(deps: AdcDeps = {}) {
    this.env = deps.env ?? process.env;
    this.info = deps.info ?? (() => readAdcInfo(adcPath(this.env)));
    this.exec = deps.exec ?? defaultExec;
    this.now = deps.now ?? Date.now;
  }

  resetCache(): void {
    this.cached = undefined;
  }

  /**
   * `gcloud auth application-default login` always writes the default ADC file. When GOOGLE_APPLICATION_CREDENTIALS
   * selects another file, admobctl keeps reading that one, so a sign-in cannot fix it: this returns the manual step.
   */
  signInBlocked(): string | undefined {
    const selected = this.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!selected || resolve(selected) === resolve(adcPath({ ...this.env, GOOGLE_APPLICATION_CREDENTIALS: undefined }))) return undefined;
    return UNSET_FIX;
  }

  /** The fix when the credentials in use are the problem. */
  private loginFix(): string {
    return this.signInBlocked() ?? "admobctl setup login --yes";
  }

  checkCredentials(): AdcInfo {
    const info = this.info();
    if (!info) {
      const selected = this.signInBlocked() && this.env.GOOGLE_APPLICATION_CREDENTIALS;
      throw new AdmobctlError(
        "AUTH_NO_CREDENTIALS",
        selected ? `GOOGLE_APPLICATION_CREDENTIALS points at ${selected}, which cannot be read.` : "No gcloud Application Default Credentials found.",
        { fix: this.loginFix() },
      );
    }
    if (info.type && info.type !== "authorized_user") {
      throw new AdmobctlError(
        "AUTH_SERVICE_ACCOUNT",
        `Your Application Default Credentials are a ${info.type}; the AdMob API only accepts user credentials (service accounts are not supported).`,
        { fix: this.loginFix() },
      );
    }
    return info;
  }

  async getToken(): Promise<string> {
    if (this.cached && this.now() - this.cached.at < TOKEN_TTL_MS) return this.cached.token;
    const info = this.checkCredentials();
    let res;
    try {
      // Pin gcloud to the exact file we just inspected, so the credential-type
      // check, the quota project and the token all describe the same identity.
      const env = { ...this.env, GOOGLE_APPLICATION_CREDENTIALS: info.path };
      res = await this.exec("gcloud", ["auth", "application-default", "print-access-token"], { timeoutMs: 30_000, env });
    } catch (err) {
      throw new AdmobctlError("AUTH_NO_CREDENTIALS", "Could not run gcloud (is the Google Cloud CLI installed and on PATH?).", {
        cause: err,
        fix: "admobctl setup login --yes",
      });
    }
    const token = res.stdout.trim();
    if (res.code !== 0 || !token) {
      const detail = res.stderr.trim().split("\n").pop() ?? "";
      if (/reauth|invalid_grant|refresh|expired/i.test(res.stderr)) {
        throw new AdmobctlError("AUTH_TOKEN_EXPIRED", `gcloud could not refresh your credentials: ${detail}`, { fix: this.loginFix() });
      }
      throw new AdmobctlError("AUTH_NO_CREDENTIALS", `gcloud failed to print an access token: ${detail}`, { fix: this.loginFix() });
    }
    this.cached = { token, at: this.now() };
    return token;
  }

  quotaProject(): string | undefined {
    return this.info()?.quotaProjectId;
  }
}
