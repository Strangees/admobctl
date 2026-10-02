import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
import type { Exec } from "../src/core/exec.js";
import { fakeFetch, jsonResponse } from "./helpers.js";

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
  });

  it("asks for the monetization scope too when write access is wanted", () => {
    const url = new URL(buildAuthUrl({ clientId: "cid", redirectUri: "http://127.0.0.1:5555", pkce: createPkce(), state: "st", write: true }));
    expect(url.searchParams.get("scope")!.split(" ")).toEqual([
      "https://www.googleapis.com/auth/admob.readonly",
      "https://www.googleapis.com/auth/admob.monetization",
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
    expect(Object.fromEntries(new URLSearchParams(f.calls[0]!.body as string))).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "rtoken",
      client_id: stored.clientId,
    });
  });

  it("asks the user to log in again when the refresh token is revoked", async () => {
    const f = fakeFetch({ "POST /token": () => jsonResponse({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400) });
    const p = new OAuthTokenProvider({ profile: "default", store: store(JSON.stringify(stored)), fetch: f.fetch });
    await expect(p.getToken()).rejects.toMatchObject({ code: "AUTH_TOKEN_EXPIRED", fix: expect.stringContaining("admobctl auth login") });
  });

  it("explains how to log in when nothing is stored", async () => {
    const p = new OAuthTokenProvider({ profile: "work", store: store(undefined) });
    await expect(p.getToken()).rejects.toMatchObject({ code: "AUTH_NO_CREDENTIALS", fix: expect.stringContaining("--profile work") });
  });
});
