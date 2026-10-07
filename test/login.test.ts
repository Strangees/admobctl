import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveTokenProvider } from "../src/core/auth/index.js";
import { login, logout, systemBrowser, type LoginOptions } from "../src/core/auth/login.js";
import type { SecretStore } from "../src/core/auth/oauth.js";
import { loadConfig, resolveProfile, saveConfig } from "../src/core/config.js";
import type { Exec } from "../src/core/exec.js";
import { fakeFetch, jsonResponse } from "./helpers.js";

function memoryStore(): SecretStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (p) => data.get(p),
    set: async (p, v) => void data.set(p, v),
    delete: async (p) => void data.delete(p),
  };
}

describe("login", () => {
  it("runs the loopback flow, stores the refresh token and switches the profile to oauth", async () => {
    const dir = mkdtempSync(join(tmpdir(), "admobctl-login-"));
    const store = memoryStore();
    const f = fakeFetch({ "POST /token": () => jsonResponse({ access_token: "a", refresh_token: "r1", expires_in: 3600, scope: "https://www.googleapis.com/auth/admob.readonly" }) });
    let shownUrl = "";
    const result = await login({
      configDir: dir,
      profile: "default",
      clientId: "cid",
      clientSecret: "cs",
      store,
      fetch: f.fetch,
      // Simulate the browser: follow the consent URL's redirect_uri with a code.
      openBrowser: async (url) => {
        shownUrl = url;
        const u = new URL(url);
        await fetch(`${u.searchParams.get("redirect_uri")}/?code=auth-code&state=${u.searchParams.get("state")}`);
      },
      print: () => {},
    });
    expect(shownUrl).toContain("accounts.google.com");
    expect(result.profile).toBe("default");
    expect(JSON.parse(store.data.get("default")!)).toEqual({ clientId: "cid", clientSecret: "cs", refreshToken: "r1" });
    const p = loadConfig(dir).profiles.default!;
    expect(p).toMatchObject({ authMode: "oauth", oauthClientId: "cid" });
    expect(JSON.stringify(loadConfig(dir))).not.toContain("r1");
  });

  it("logout deletes the secret, revokes it and returns the profile to auto", async () => {
    const dir = mkdtempSync(join(tmpdir(), "admobctl-login-"));
    saveConfig(dir, { profiles: { default: { authMode: "oauth", oauthClientId: "cid" } } });
    const store = memoryStore();
    store.data.set("default", JSON.stringify({ clientId: "cid", refreshToken: "r1" }));
    const f = fakeFetch({ "POST /revoke": () => jsonResponse({}) });
    await logout({ configDir: dir, profile: "default", store, fetch: f.fetch });
    expect(store.data.has("default")).toBe(false);
    expect(f.calls[0]!.body).toBe("token=r1");
    expect(loadConfig(dir).profiles.default!.authMode).toBe("auto");
  });
});

describe("login process handling", () => {
  const READ = "https://www.googleapis.com/auth/admob.readonly";
  /** What the browser does after consent: follow the consent URL's redirect_uri with a code. */
  const consent = (url: string) => {
    const u = new URL(url);
    return fetch(`${u.searchParams.get("redirect_uri")}/?code=auth-code&state=${u.searchParams.get("state")}`);
  };
  const options = (o: Partial<LoginOptions>): LoginOptions => ({
    configDir: mkdtempSync(join(tmpdir(), "admobctl-login-")),
    profile: "default",
    clientId: "cid",
    store: memoryStore(),
    fetch: fakeFetch({ "POST /token": () => jsonResponse({ access_token: "a", refresh_token: "r1", expires_in: 3600, scope: READ }) }).fetch,
    print: () => {},
    ...o,
  });

  it("does not wait for the browser program to exit", async () => {
    const r = await login(options({ openBrowser: (url) => (void consent(url), new Promise<void>(() => {})) }));
    expect(r.profile).toBe("default");
  });

  it("fails cleanly when the sign-in times out while the browser launch is still pending", async () => {
    const err = await login(options({ timeoutMs: 50, openBrowser: () => new Promise<void>(() => {}) })).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "AUTH_NO_CREDENTIALS", message: expect.stringMatching(/Timed out/) });
  });

  it("starts the system browser in the background, not tied to admobctl's output", async () => {
    const calls: Array<Parameters<Exec>> = [];
    await systemBrowser(async (...a) => (calls.push(a), { code: 0, stdout: "", stderr: "" }))("https://example.com/consent");
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toContain("https://example.com/consent");
    expect(calls[0]![2]).toMatchObject({ background: true });
  });
});

describe("resolveTokenProvider", () => {
  it("uses ADC for auto and adc, own OAuth for oauth", () => {
    const deps = { configDir: "/tmp/x" };
    expect(resolveTokenProvider(resolveProfile({ profiles: {} }), deps).mode).toBe("adc");
    expect(resolveTokenProvider(resolveProfile({ profiles: { default: { authMode: "adc" } } }), deps).mode).toBe("adc");
    expect(resolveTokenProvider(resolveProfile({ profiles: { default: { authMode: "oauth" } } }), deps).mode).toBe("oauth");
  });
});
