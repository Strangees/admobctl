import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { AdmobctlError, ADMOB_SCOPE, ADSENSE_SCOPE, CLOUD_PLATFORM_SCOPE, MONETIZATION_SCOPE } from "../errors.js";
import { exec as defaultExec, type Exec } from "../exec.js";
import { ensurePrivateDir } from "../fs.js";
import type { TokenProvider } from "./types.js";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const KEYCHAIN_SERVICE = "admobctl";

/** What we keep in the keychain per profile. Desktop-app client secrets are not confidential, but we store them alongside anyway. */
export interface StoredOAuth {
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
}

// ── secret storage ────────────────────────────────────────────────

export interface SecretStore {
  get(profile: string): Promise<string | undefined>;
  set(profile: string, value: string): Promise<void>;
  delete(profile: string): Promise<void>;
}

/** macOS Keychain via `security`. Secrets go over stdin (`security -i`), never argv. */
export class KeychainSecretStore implements SecretStore {
  constructor(private readonly exec: Exec = defaultExec) {}

  async get(profile: string): Promise<string | undefined> {
    const r = await this.exec("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", profile, "-w"]);
    if (r.code !== 0) return undefined;
    return r.stdout.replace(/\n$/, "") || undefined;
  }

  async set(profile: string, value: string): Promise<void> {
    if (!/^[A-Za-z0-9._-]+$/.test(profile)) throw new AdmobctlError("USAGE", `Invalid profile name "${profile}"`);
    const hex = Buffer.from(value, "utf8").toString("hex");
    const r = await this.exec("security", ["-i"], {
      input: `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${profile} -X ${hex}\n`,
    });
    if (r.code !== 0) throw new AdmobctlError("CONFIG", `Could not write to the macOS Keychain: ${r.stderr.trim()}`);
  }

  async delete(profile: string): Promise<void> {
    await this.exec("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", profile]);
  }
}

/** Fallback for non-macOS: one 0600 file per profile in the config dir. */
export class FileSecretStore implements SecretStore {
  constructor(private readonly dir: string) {}

  private file(profile: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(profile)) throw new AdmobctlError("USAGE", `Invalid profile name "${profile}"`);
    return join(this.dir, `credentials-${profile}.json`);
  }

  async get(profile: string): Promise<string | undefined> {
    const f = this.file(profile);
    return existsSync(f) ? readFileSync(f, "utf8") : undefined;
  }

  async set(profile: string, value: string): Promise<void> {
    ensurePrivateDir(this.dir);
    const file = this.file(profile);
    // `mode` only applies on create, so write a fresh 0600 temp file (wx: never reuse a stale one) and rename over the target.
    const tmp = `${file}.${process.pid}.tmp`;
    rmSync(tmp, { force: true });
    writeFileSync(tmp, value, { mode: 0o600, flag: "wx" });
    renameSync(tmp, file);
    chmodSync(file, 0o600);
  }

  async delete(profile: string): Promise<void> {
    rmSync(this.file(profile), { force: true });
  }
}

export function defaultSecretStore(configDir: string, exec?: Exec): SecretStore {
  return process.platform === "darwin" ? new KeychainSecretStore(exec) : new FileSecretStore(configDir);
}

// ── login flow ────────────────────────────────────────────────────

export interface Pkce {
  verifier: string;
  challenge: string;
}

export function createPkce(): Pkce {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** `write` adds admob.monetization (write commands); `payments` adds adsense.readonly (finance balance). */
export function buildAuthUrl(o: {
  clientId: string;
  redirectUri: string;
  pkce: Pkce;
  state: string;
  write?: boolean;
  payments?: boolean;
  cloudPlatform?: boolean;
}): string {
  const url = new URL(AUTH_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    response_type: "code",
    scope: [ADMOB_SCOPE, ...(o.write ? [MONETIZATION_SCOPE] : []), ...(o.payments ? [ADSENSE_SCOPE] : []), ...(o.cloudPlatform ? [CLOUD_PLATFORM_SCOPE] : [])].join(" "),
    code_challenge: o.pkce.challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
    state: o.state,
  }).toString();
  return url.toString();
}

const DONE_PAGE = `<!doctype html><meta charset="utf-8"><title>admobctl</title>
<body style="font:16px system-ui;margin:3em">Signed in. You can close this tab and return to the terminal.</body>`;

/** Listen on 127.0.0.1:<random> for Google's redirect and resolve with the authorization code. */
export function waitForLoopbackCode(o: { state: string; timeoutMs?: number }) {
  let resolveReady!: (v: { redirectUri: string }) => void;
  const ready = new Promise<{ redirectUri: string }>((r) => (resolveReady = r));
  const code = new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const err = url.searchParams.get("error");
      const got = url.searchParams.get("code");
      const finish = (status: number, body: string, outcome: () => void) => {
        res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(body);
        clearTimeout(timer);
        server.close();
        outcome();
      };
      if (!got && !err) return void res.writeHead(404).end();
      if (url.searchParams.get("state") !== o.state) {
        return finish(400, "State mismatch.", () => reject(new AdmobctlError("AUTH_NO_CREDENTIALS", "OAuth state mismatch; login aborted.")));
      }
      if (err) return finish(400, `Login failed: ${err}`, () => reject(new AdmobctlError("AUTH_NO_CREDENTIALS", `Google returned an error: ${err}`)));
      finish(200, DONE_PAGE, () => resolve(got!));
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new AdmobctlError("AUTH_NO_CREDENTIALS", "Timed out waiting for the browser login.", { fix: "admobctl auth login" }));
    }, o.timeoutMs ?? 300_000);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolveReady({ redirectUri: `http://127.0.0.1:${port}` });
    });
    server.on("error", reject);
  });
  return { ready, code };
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function postToken(params: Record<string, string>, doFetch: typeof fetch): Promise<TokenResponse> {
  const res = await doFetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || json.error) {
    const msg = `${json.error ?? res.status}${json.error_description ? `: ${json.error_description}` : ""}`;
    if (json.error === "invalid_grant") {
      throw new AdmobctlError("AUTH_TOKEN_EXPIRED", `Your saved login is no longer valid (${msg}).`, { fix: "admobctl auth login" });
    }
    throw new AdmobctlError("AUTH_NO_CREDENTIALS", `Google token endpoint error: ${msg}`, {
      fix: "Check the OAuth client ID/secret (a Desktop app client in Google Cloud Console), then: admobctl auth login",
    });
  }
  return json;
}

export async function exchangeCode(
  o: { clientId: string; clientSecret?: string; code: string; verifier: string; redirectUri: string },
  doFetch: typeof fetch = fetch,
): Promise<{ refreshToken: string; accessToken?: string; scope?: string }> {
  const params: Record<string, string> = {
    grant_type: "authorization_code",
    code: o.code,
    code_verifier: o.verifier,
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
  };
  if (o.clientSecret) params.client_secret = o.clientSecret;
  const t = await postToken(params, doFetch);
  if (!t.refresh_token) {
    throw new AdmobctlError("AUTH_NO_CREDENTIALS", "Google did not return a refresh token.", {
      fix: "Remove admobctl's access at https://myaccount.google.com/permissions and run admobctl auth login again.",
    });
  }
  return { refreshToken: t.refresh_token, accessToken: t.access_token, scope: t.scope };
}

export async function revokeToken(token: string, doFetch: typeof fetch = fetch): Promise<void> {
  await doFetch(REVOKE_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
  }).catch(() => undefined);
}

// ── token provider ────────────────────────────────────────────────

export interface OAuthProviderDeps {
  profile: string;
  store: SecretStore;
  fetch?: typeof fetch;
  now?: () => number;
}

export class OAuthTokenProvider implements TokenProvider {
  readonly mode = "oauth" as const;
  private cached?: { token: string; expiresAt: number };

  constructor(private readonly deps: OAuthProviderDeps) {}

  private loginFix(): string {
    return `admobctl auth login --client-id <id>${this.deps.profile === "default" ? "" : ` --profile ${this.deps.profile}`}`;
  }

  async stored(): Promise<StoredOAuth> {
    const raw = await this.deps.store.get(this.deps.profile);
    if (!raw) {
      throw new AdmobctlError("AUTH_NO_CREDENTIALS", `No saved admobctl login for profile "${this.deps.profile}".`, { fix: this.loginFix() });
    }
    try {
      return JSON.parse(raw) as StoredOAuth;
    } catch {
      throw new AdmobctlError("AUTH_NO_CREDENTIALS", "The saved login is corrupt.", { fix: this.loginFix() });
    }
  }

  async checkCredentials(): Promise<StoredOAuth> {
    return this.stored();
  }

  resetCache(): void {
    this.cached = undefined;
  }

  async getToken(): Promise<string> {
    const now = (this.deps.now ?? Date.now)();
    if (this.cached && now < this.cached.expiresAt) return this.cached.token;
    const s = await this.stored();
    const params: Record<string, string> = { grant_type: "refresh_token", refresh_token: s.refreshToken, client_id: s.clientId };
    if (s.clientSecret) params.client_secret = s.clientSecret;
    const t = await postToken(params, this.deps.fetch ?? fetch);
    if (!t.access_token) throw new AdmobctlError("AUTH_NO_CREDENTIALS", "Google returned no access token.", { fix: this.loginFix() });
    // Refresh a minute early.
    this.cached = { token: t.access_token, expiresAt: now + ((t.expires_in ?? 3600) - 60) * 1000 };
    return t.access_token;
  }

  quotaProject(): string | undefined {
    return undefined;
  }
}
