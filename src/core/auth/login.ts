import { randomBytes } from "node:crypto";
import { loadConfig, saveConfig, setProfileValue } from "../config.js";
import { exec as defaultExec, type Exec } from "../exec.js";
import { featuresFromScopes, type Feature } from "../setup/features.js";
import { buildAuthUrl, createPkce, exchangeCode, revokeToken, waitForLoopbackCode, type SecretStore, type StoredOAuth } from "./oauth.js";

export interface LoginOptions {
  configDir: string;
  profile: string;
  clientId: string;
  clientSecret?: string;
  store: SecretStore;
  fetch?: typeof fetch;
  /** Open the consent URL; defaults to the OS browser. */
  openBrowser?: (url: string) => Promise<void>;
  /** Where to print instructions (stderr). */
  print: (s: string) => void;
  /** Also ask for admob.monetization, for the write commands. */
  write?: boolean;
  /** Also ask for adsense.readonly, for finance balance. */
  payments?: boolean;
  /** Also ask for cloud-platform, for setup project and API management. */
  cloudPlatform?: boolean;
  /** How long to wait for the browser sign-in (default 5 minutes). */
  timeoutMs?: number;
}

export function systemBrowser(exec: Exec = defaultExec) {
  return async (url: string) => {
    const [cmd, args] =
      process.platform === "darwin"
        ? ["open", [url]]
        : process.platform === "win32"
          ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
          : ["xdg-open", [url]];
    // In the background: an opener such as xdg-open can keep running (and would hold admobctl's stdio) until the browser closes.
    await exec(cmd as string, args as string[], { background: true }).catch(() => undefined);
  };
}

/** The `auth login` that repeats a sign-in: same client and scopes (the CLI adds --profile). */
export function authLoginCommand(o: Pick<LoginOptions, "clientId" | "write" | "payments" | "cloudPlatform">): string {
  const id = /^[A-Za-z0-9._-]+$/.test(o.clientId) ? o.clientId : `'${o.clientId.replace(/'/g, "'\\''")}'`;
  return `admobctl auth login --client-id ${id}${o.write ? " --write" : ""}${o.payments ? " --payments" : ""}${o.cloudPlatform ? " --cloud-platform" : ""}`;
}

/**
 * Desktop OAuth (loopback + PKCE). Stores the refresh token in the secret store, switches the profile to oauth and
 * records the features the granted scopes allow, so a later `setup login` asks for them again.
 */
export async function login(o: LoginOptions): Promise<{ profile: string; scope?: string }> {
  const pkce = createPkce();
  const state = randomBytes(16).toString("hex");
  // A first sign-in has no saved secret yet, so repeating it needs the secret again (the secret never goes in a fix).
  const fix = `${authLoginCommand(o)}${o.clientSecret ? "  (with --client-secret too if you passed it)" : ""}`;
  const wait = waitForLoopbackCode({ state, timeoutMs: o.timeoutMs, fix });
  const { redirectUri } = await wait.ready;
  const url = buildAuthUrl({ clientId: o.clientId, redirectUri, pkce, state, write: o.write, payments: o.payments, cloudPlatform: o.cloudPlatform });
  o.print(`Opening your browser to sign in to Google. If it does not open, visit:\n\n  ${url}\n\n`);
  // Not awaited: the sign-in completes through the redirect, and the printed URL works without the browser launch.
  const open = o.openBrowser ?? systemBrowser();
  void Promise.resolve()
    .then(() => open(url))
    .catch(() => undefined);
  const code = await wait.code;
  const t = await exchangeCode({ clientId: o.clientId, clientSecret: o.clientSecret, code, verifier: pkce.verifier, redirectUri, fix }, o.fetch);
  const stored: StoredOAuth = { clientId: o.clientId, refreshToken: t.refreshToken };
  if (o.clientSecret) stored.clientSecret = o.clientSecret;
  await o.store.set(o.profile, JSON.stringify({ clientId: stored.clientId, clientSecret: stored.clientSecret, refreshToken: stored.refreshToken }));
  const cfg = loadConfig(o.configDir);
  setProfileValue(cfg, o.profile, "oauthClientId", o.clientId);
  setProfileValue(cfg, o.profile, "authMode", "oauth");
  const requested: Feature[] = ["read", ...(o.write ? (["write"] as const) : []), ...(o.payments ? (["payments"] as const) : [])];
  setProfileValue(cfg, o.profile, "features", (t.scope ? featuresFromScopes(t.scope.split(" ")) : requested).join(","));
  saveConfig(o.configDir, cfg);
  return { profile: o.profile, scope: t.scope };
}

export async function logout(o: { configDir: string; profile: string; store: SecretStore; fetch?: typeof fetch }): Promise<void> {
  const raw = await o.store.get(o.profile);
  if (raw) {
    try {
      await revokeToken((JSON.parse(raw) as StoredOAuth).refreshToken, o.fetch);
    } catch {
      // Revocation is best effort.
    }
  }
  await o.store.delete(o.profile);
  const cfg = loadConfig(o.configDir);
  setProfileValue(cfg, o.profile, "authMode", "auto");
  saveConfig(o.configDir, cfg);
}
