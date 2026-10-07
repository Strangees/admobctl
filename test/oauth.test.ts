import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildAuthUrl,
  createPkce,
  exchangeCode,
  FileSecretStore,
  KeychainSecretStore,
  OAuthTokenProvider,
  waitForLoopbackCode,
  type StoredOAuth,
} from "../src/core/auth/oauth.js";
import { AdmobctlError } from "../src/core/errors.js";
import type { Exec } from "../src/core/exec.js";
import { log } from "../src/core/log.js";
import { fakeFetch, jsonResponse, noSleep } from "./helpers.js";

const stored: StoredOAuth = { clientId: "cid.apps.googleusercontent.com", clientSecret: "csecret", refreshToken: "rtoken" };

describe("PKCE + auth URL", () => {
  it("builds a Google consent URL with S256 PKCE, loopback redirect and offline access", () => {
    const pkce = createPkce();
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    const url = new URL(buildAuthUrl({ clientId: "cid", redirectUri: "http://127.0.0.1:5555", pkce, state: "st" }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "cid",
      redirect_uri: "http://127.0.0.1:5555",
      response_type: "code",
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
      state: "st",
    });
    expect(url.searchParams.get("scope")).toContain("admob.readonly");
    expect(url.searchParams.get("scope")).not.toContain("admob.monetization");
    expect(url.searchParams.get("scope")).not.toContain("cloud-platform");
  });

  it("asks for the monetization scope too when write access is wanted", () => {
    const url = new URL(buildAuthUrl({ clientId: "cid", redirectUri: "http://127.0.0.1:5555", pkce: createPkce(), state: "st", write: true }));
    expect(url.searchParams.get("scope")!.split(" ")).toEqual([
      "https://www.googleapis.com/auth/admob.readonly",
      "https://www.googleapis.com/auth/admob.monetization",
    ]);
  });

  it("asks for the adsense scope when payments access is wanted", () => {
    const url = new URL(buildAuthUrl({ clientId: "cid", redirectUri: "http://127.0.0.1:5555", pkce: createPkce(), state: "st", payments: true }));
    expect(url.searchParams.get("scope")!.split(" ")).toEqual([
      "https://www.googleapis.com/auth/admob.readonly",
      "https://www.googleapis.com/auth/adsense.readonly",
    ]);
  });

  it("combines write and payments scopes, AdMob first", () => {
    const url = new URL(
      buildAuthUrl({ clientId: "cid", redirectUri: "http://127.0.0.1:5555", pkce: createPkce(), state: "st", write: true, payments: true }),
    );
    expect(url.searchParams.get("scope")!.split(" ")).toEqual([
      "https://www.googleapis.com/auth/admob.readonly",
      "https://www.googleapis.com/auth/admob.monetization",
      "https://www.googleapis.com/auth/adsense.readonly",
    ]);
  });

  it("adds cloud-platform for setup without dropping requested OAuth features", () => {
    const url = new URL(
      buildAuthUrl({
        clientId: "cid",
        redirectUri: "http://127.0.0.1:5555",
        pkce: createPkce(),
        state: "st",
        write: true,
        payments: true,
        cloudPlatform: true,
      }),
    );
    expect(url.searchParams.get("scope")!.split(" ")).toEqual([
      "https://www.googleapis.com/auth/admob.readonly",
      "https://www.googleapis.com/auth/admob.monetization",
      "https://www.googleapis.com/auth/adsense.readonly",
      "https://www.googleapis.com/auth/cloud-platform",
    ]);
  });
});

describe("waitForLoopbackCode", () => {
  it("returns the code when state matches", async () => {
    const wait = waitForLoopbackCode({ state: "abc", timeoutMs: 5000 });
    const { redirectUri } = await wait.ready;
    const res = await fetch(`${redirectUri}/?code=the-code&state=abc`);
    expect(res.status).toBe(200);
    await expect(wait.code).resolves.toBe("the-code");
  });

  it("rejects a mismatched state", async () => {
    const wait = waitForLoopbackCode({ state: "abc", timeoutMs: 5000 });
    const { redirectUri } = await wait.ready;
    const settled = wait.code.catch((e: Error) => e);
    await fetch(`${redirectUri}/?code=x&state=evil`);
    expect(String(await settled)).toMatch(/state/);
  });
});

describe("exchangeCode", () => {
  it("posts the code with the PKCE verifier and returns the refresh token", async () => {
    const f = fakeFetch({ "POST /token": () => jsonResponse({ access_token: "a", refresh_token: "r", expires_in: 3599, scope: "s" }) });
    const t = await exchangeCode({ clientId: "cid", clientSecret: "cs", code: "c", verifier: "v", redirectUri: "http://127.0.0.1:1" }, f.fetch);
    expect(t.refreshToken).toBe("r");
    const body = new URLSearchParams(f.calls[0]!.body as string);
    expect(Object.fromEntries(body)).toMatchObject({ grant_type: "authorization_code", code: "c", code_verifier: "v", client_id: "cid", client_secret: "cs" });
  });
});

describe("KeychainSecretStore", () => {
  it("passes the secret on stdin, never in argv", async () => {
    const seen: Array<{ cmd: string; args: string[]; input?: string }> = [];
    const exec: Exec = async (cmd, args, opts) => {
      seen.push({ cmd, args, input: opts?.input });
      return { code: 0, stdout: "", stderr: "" };
    };
    await new KeychainSecretStore(exec).set("default", JSON.stringify(stored));
    expect(seen[0]!.cmd).toBe("security");
    expect(seen[0]!.args).toEqual(["-i"]);
    expect(seen[0]!.args.join(" ")).not.toContain("rtoken");
    expect(seen[0]!.input).toMatch(/^add-generic-password -U -s admobctl -a default -X [0-9a-f]+\n$/);
  });

  it("reads and decodes a stored secret, and treats 'not found' as empty", async () => {
    const exec: Exec = async (_c, args) =>
      args.includes("missing")
        ? { code: 44, stdout: "", stderr: "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." }
        : { code: 0, stdout: `${JSON.stringify(stored)}\n`, stderr: "" };
    const store = new KeychainSecretStore(exec);
    expect(JSON.parse((await store.get("default"))!)).toEqual(stored);
    expect(await store.get("missing")).toBeUndefined();
  });

  it("reports a locked or unreachable keychain as such, not as a missing login", async () => {
    for (const [code, stderr] of [
      [36, "security: SecKeychainSearchCopyNext: User interaction is not allowed."],
      [51, "security: SecKeychainSearchCopyNext: The user name or passphrase you entered is not correct."],
    ] as const) {
      const store = new KeychainSecretStore(async () => ({ code, stdout: "", stderr }));
      const err = (await store.get("default").catch((e: unknown) => e)) as AdmobctlError;
      expect(err).toMatchObject({ code: "CONFIG", message: expect.stringContaining(stderr) });
      expect(err.message).toMatch(/Keychain/);
      expect(err.fix).toMatch(/unlock/i);
    }
  });
});

describe("FileSecretStore", () => {
  it("writes owner-only files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "admobctl-sec-"));
    const store = new FileSecretStore(dir);
    await store.set("default", "s3cret");
    expect(await store.get("default")).toBe("s3cret");
    const file = join(dir, "credentials-default.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toContain("s3cret");
    await store.delete("default");
    expect(await store.get("default")).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("tightens a pre-existing world-readable credentials file to 0600", async () => {
    const dir = mkdtempSync(join(tmpdir(), "admobctl-sec-"));
    const file = join(dir, "credentials-default.json");
    writeFileSync(file, "old", { mode: 0o644 });
    chmodSync(file, 0o644);
    const store = new FileSecretStore(dir);
    await store.set("default", "n3w");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toBe("n3w");
  });

  it.skipIf(process.platform === "win32")("creates a missing dir as 0700", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "admobctl-sec-")), "fresh", ".admobctl");
    await new FileSecretStore(dir).set("default", "s3cret");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform === "win32")("tightens a pre-existing loose .admobctl dir to 0700", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "admobctl-sec-")), ".admobctl");
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    expect(statSync(dir).mode & 0o777).toBe(0o755);
    await new FileSecretStore(dir).set("default", "s3cret");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform === "win32")("leaves any other loose dir alone and warns with the fix", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const dir = join(mkdtempSync(join(tmpdir(), "admobctl-sec-")), "shared");
      mkdirSync(dir);
      chmodSync(dir, 0o755);
      expect(statSync(dir).mode & 0o777).toBe(0o755);
      await new FileSecretStore(dir).set("default", "s3cret");
      expect(statSync(dir).mode & 0o777).toBe(0o755);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain(`chmod 700 ${dir}`);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("OAuthTokenProvider", () => {
  const store = (value?: string) => ({
    get: async () => value,
    set: async () => {},
    delete: async () => {},
  });

  it("refreshes an access token and caches it until near expiry", async () => {
    let now = 0;
    const f = fakeFetch({ "POST /token": () => jsonResponse({ access_token: `tok${f.calls.length}`, expires_in: 3600 }) });
    const p = new OAuthTokenProvider({ profile: "default", store: store(JSON.stringify(stored)), fetch: f.fetch, now: () => now });
    expect(await p.getToken()).toBe("tok1");
    now = 3000_000;
    expect(await p.getToken()).toBe("tok1");
    now = 3560_000;
    expect(await p.getToken()).toBe("tok2");
    p.resetCache();
    expect(await p.getToken()).toBe("tok3");
    expect(Object.fromEntries(new URLSearchParams(f.calls[0]!.body as string))).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "rtoken",
      client_id: stored.clientId,
    });
  });

  it("asks the user to log in again when the refresh token is revoked", async () => {
    const f = fakeFetch({ "POST /token": () => jsonResponse({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400) });
    const p = new OAuthTokenProvider({ profile: "default", store: store(JSON.stringify(stored)), fetch: f.fetch });
    await expect(p.getToken()).rejects.toMatchObject({ code: "AUTH_TOKEN_EXPIRED", fix: "admobctl setup login --yes" });
    const work = new OAuthTokenProvider({ profile: "work", store: store(JSON.stringify(stored)), fetch: f.fetch });
    await expect(work.getToken()).rejects.toMatchObject({ fix: "admobctl --profile work setup login --yes" });
  });

  it("retries a transient 5xx from the token endpoint", async () => {
    const f = fakeFetch({
      "POST /token": () => (f.calls.length === 1 ? jsonResponse({ error: "internal_failure" }, 503) : jsonResponse({ access_token: "tok", expires_in: 3600 })),
    });
    const p = new OAuthTokenProvider({ profile: "default", store: store(JSON.stringify(stored)), fetch: f.fetch, sleep: noSleep });
    expect(await p.getToken()).toBe("tok");
    expect(f.calls).toHaveLength(2);
  });

  it("reports a token endpoint that stays down as an outage, not as a client ID/secret problem", async () => {
    const f = fakeFetch({ "POST /token": () => jsonResponse({}, 503) });
    const p = new OAuthTokenProvider({ profile: "default", store: store(JSON.stringify(stored)), fetch: f.fetch, sleep: noSleep });
    const err = (await p.getToken().catch((e: unknown) => e)) as AdmobctlError;
    expect(err).toMatchObject({ name: "AdmobctlError", code: "API_ERROR", status: 503 });
    expect(`${err.message} ${err.fix}`).not.toMatch(/client ID|secret/i);
    expect(f.calls).toHaveLength(3);
  });

  it("turns a network failure into an AdmobctlError with a fix", async () => {
    let calls = 0;
    const down = (async () => {
      calls++;
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const p = new OAuthTokenProvider({ profile: "default", store: store(JSON.stringify(stored)), fetch: down, sleep: noSleep });
    const err = (await p.getToken().catch((e: unknown) => e)) as AdmobctlError;
    expect(err).toBeInstanceOf(AdmobctlError);
    expect(err.message).toMatch(/oauth2\.googleapis\.com/);
    expect(err.fix).toBeTruthy();
    expect(calls).toBe(3);
  });

  it("gives every token request a timeout", async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    const f = (async (_u: string, init: RequestInit = {}) => (signals.push(init.signal), jsonResponse({ access_token: "tok" }))) as unknown as typeof fetch;
    await new OAuthTokenProvider({ profile: "default", store: store(JSON.stringify(stored)), fetch: f }).getToken();
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  it("treats invalid_client as a problem with the OAuth client, without placeholders in the fix", async () => {
    const f = fakeFetch({ "POST /token": () => jsonResponse({ error: "invalid_client", error_description: "The OAuth client was not found." }, 401) });
    const p = new OAuthTokenProvider({ profile: "default", store: store(JSON.stringify(stored)), fetch: f.fetch, sleep: noSleep });
    const err = (await p.getToken().catch((e: unknown) => e)) as AdmobctlError;
    expect(err).toMatchObject({ code: "AUTH_NO_CREDENTIALS", message: expect.stringContaining("invalid_client") });
    expect(err.fix).toMatch(/OAuth client/);
    expect(err.fix).not.toMatch(/</);
    expect(f.calls).toHaveLength(1);
  });

  it("never logs the refresh token, client secret or access token", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string) => (lines.push(String(chunk)), true)) as typeof process.stderr.write);
    log.setVerbose(true);
    try {
      const f = fakeFetch({ "POST /token": () => jsonResponse({ access_token: "ya29.secret-access", expires_in: 3600 }) });
      await new OAuthTokenProvider({ profile: "default", store: store(JSON.stringify(stored)), fetch: f.fetch }).getToken();
      const bad = fakeFetch({ "POST /token": () => jsonResponse({ error: "invalid_grant" }, 400) });
      await new OAuthTokenProvider({ profile: "default", store: store(JSON.stringify(stored)), fetch: bad.fetch }).getToken().catch(() => {});
    } finally {
      log.setVerbose(false);
      spy.mockRestore();
    }
    const out = lines.join("");
    expect(out).toContain("oauth2.googleapis.com/token");
    for (const secret of ["rtoken", "csecret", "ya29.secret-access"]) expect(out).not.toContain(secret);
  });

  it("rejects a saved login of the wrong shape with a clear error", async () => {
    for (const raw of ["null", "5", '"x"', "[]", '{"clientId":"cid"}', '{"clientId":5,"refreshToken":"r"}', '{"clientId":"cid","refreshToken":"r","clientSecret":7}', "{"]) {
      const p = new OAuthTokenProvider({ profile: "default", store: store(raw) });
      await expect(p.getToken(), raw).rejects.toMatchObject({ name: "AdmobctlError", code: "AUTH_NO_CREDENTIALS", message: expect.stringMatching(/corrupt/) });
    }
    const ok = new OAuthTokenProvider({ profile: "default", store: store('{"clientId":"cid","refreshToken":"r"}') });
    expect(await ok.stored()).toEqual({ clientId: "cid", refreshToken: "r" });
  });

  it("explains how to log in when nothing is stored, keeping the profile's client and features", async () => {
    const p = new OAuthTokenProvider({ profile: "work", store: store(undefined) });
    await expect(p.getToken()).rejects.toMatchObject({ code: "AUTH_NO_CREDENTIALS", fix: "admobctl --profile work setup login --yes" });
  });
});
