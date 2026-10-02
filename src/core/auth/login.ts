import { randomBytes } from "node:crypto";
import { loadConfig, saveConfig, setProfileValue } from "../config.js";
import { exec as defaultExec, type Exec } from "../exec.js";
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
}

export function systemBrowser(exec: Exec = defaultExec) {
  return async (url: string) => {
    const [cmd, args] =
      process.platform === "darwin"
        ? ["open", [url]]
        : process.platform === "win32"
          ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
          : ["xdg-open", [url]];
    await exec(cmd as string, args as string[]).catch(() => undefined);
  };
}

/** Desktop OAuth (loopback + PKCE). Stores the refresh token in the secret store and switches the profile to oauth. */
export async function login(o: LoginOptions): Promise<{ profile: string; scope?: string }> {
  const pkce = createPkce();
  const state = randomBytes(16).toString("hex");
  const wait = waitForLoopbackCode({ state });
  const { redirectUri } = await wait.ready;
  const url = buildAuthUrl({ clientId: o.clientId, redirectUri, pkce, state, write: o.write });
  o.print(`Opening your browser to sign in to Google. If it does not open, visit:\n\n  ${url}\n\n`);
  await (o.openBrowser ?? systemBrowser())(url);
  const code = await wait.code;
  const t = await exchangeCode({ clientId: o.clientId, clientSecret: o.clientSecret, code, verifier: pkce.verifier, redirectUri }, o.fetch);
  const stored: StoredOAuth = { clientId: o.clientId, refreshToken: t.refreshToken };
  if (o.clientSecret) stored.clientSecret = o.clientSecret;
  await o.store.set(o.profile, JSON.stringify({ clientId: stored.clientId, clientSecret: stored.clientSecret, refreshToken: stored.refreshToken }));
  const cfg = loadConfig(o.configDir);
  setProfileValue(cfg, o.profile, "oauthClientId", o.clientId);
  setProfileValue(cfg, o.profile, "authMode", "oauth");
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
