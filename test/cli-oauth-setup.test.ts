import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { login } from "../src/core/auth/login.js";
import { run } from "../src/cli/program.js";
import { saveConfig } from "../src/core/config.js";
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
