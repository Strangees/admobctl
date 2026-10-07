import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { login } from "../src/core/auth/login.js";
import { run } from "../src/cli/program.js";
import { saveConfig } from "../src/core/config.js";
import { AdmobctlError } from "../src/core/errors.js";
import { fakeFetch, jsonResponse } from "./helpers.js";

vi.mock("../src/core/auth/login.js", () => ({ login: vi.fn(async () => ({ profile: "default" })), logout: vi.fn() }));
vi.mock("../src/core/auth/oauth.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/core/auth/oauth.js")>(),
  defaultSecretStore: () => ({
    get: async () => JSON.stringify({ clientId: "example-client", clientSecret: "example-secret", refreshToken: "example-refresh" }),
    set: async () => {}, delete: async () => {},
  }),
}));

it("setup OAuth reuses the saved Desktop client secret and requests the setup scope", async () => {
  vi.stubEnv("ADMOBCTL_OAUTH_CLIENT_SECRET", undefined);
  const dir = mkdtempSync(join(tmpdir(), "admobctl-oauth-cli-"));
  saveConfig(dir, { profiles: { default: { authMode: "oauth", oauthClientId: "example-client" } } });
  const f = fakeFetch({ "POST /tokeninfo": () => jsonResponse({ scope: "https://www.googleapis.com/auth/admob.readonly" }) });
  let stderr = "";
  const code = await run(["node", "admobctl", "setup", "login", "--yes"], {
    stdout: () => {}, stderr: (s) => { stderr += s; }, isTTY: true, stdinIsTTY: true,
    service: {
      configDir: dir, fetch: f.fetch,
      tokenProvider: { mode: "oauth", getToken: async () => "example-token", quotaProject: () => undefined },
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    },
  });
  vi.unstubAllEnvs();
  expect(code, stderr).toBe(0);
  expect(login).toHaveBeenCalledWith(expect.objectContaining({ clientId: "example-client", clientSecret: "example-secret", cloudPlatform: true }));
});

it("after an expired OAuth login, setup login --yes signs in again with the saved client and the profile's features", async () => {
  vi.mocked(login).mockClear();
  vi.stubEnv("ADMOBCTL_OAUTH_CLIENT_SECRET", undefined);
  const dir = mkdtempSync(join(tmpdir(), "admobctl-oauth-cli-"));
  saveConfig(dir, { profiles: { default: { authMode: "oauth", oauthClientId: "example-client", features: ["read", "write", "payments"] } } });
  const expired = new AdmobctlError("AUTH_TOKEN_EXPIRED", "Your saved login is no longer valid (invalid_grant).", { fix: "admobctl setup login --yes" });
  let stderr = "";
  const code = await run(["node", "admobctl", "setup", "login", "--yes"], {
    stdout: () => {}, stderr: (s) => { stderr += s; }, isTTY: true, stdinIsTTY: true,
    service: {
      configDir: dir, fetch: fakeFetch({}).fetch,
      tokenProvider: { mode: "oauth", getToken: async () => Promise.reject(expired), quotaProject: () => undefined },
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    },
  });
  vi.unstubAllEnvs();
  expect(code, stderr).toBe(0);
  expect(login).toHaveBeenCalledWith(expect.objectContaining({ clientId: "example-client", clientSecret: "example-secret", write: true, payments: true }));
});

it("asks for an OAuth client without placeholder text in the fix", async () => {
  const dir = mkdtempSync(join(tmpdir(), "admobctl-oauth-cli-"));
  let stderr = "";
  const code = await run(["node", "admobctl", "auth", "login", "-o", "json"], {
    stdout: () => {}, stderr: (s) => { stderr += s; }, isTTY: false, stdinIsTTY: true,
    service: { configDir: dir, fetch: fakeFetch({}).fetch, exec: async () => ({ code: 0, stdout: "", stderr: "" }) },
  });
  expect(code).toBe(2);
  const { error } = JSON.parse(stderr) as { error: { fix: string } };
  expect(error.fix).toMatch(/--client-id/);
  expect(error.fix).not.toMatch(/</);
});
