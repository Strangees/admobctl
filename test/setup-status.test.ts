import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TokenProvider } from "../src/core/auth/types.js";
import { saveConfig } from "../src/core/config.js";
import { AdmobService } from "../src/core/service.js";
import { setupStatus } from "../src/core/setup/status.js";
import { fakeFetch, fixture, jsonResponse, noSleep } from "./helpers.js";

const token: TokenProvider = { mode: "adc", getToken: async () => "t", quotaProject: () => "example-project", checkCredentials: () => ({}) };

function service(adsense: "ENABLED" | "DISABLED", scopes: string, profileName = "default") {
  const dir = mkdtempSync(join(tmpdir(), "admobctl-status-"));
  saveConfig(dir, { profiles: { [profileName]: { features: ["read", "payments"] } } });
  const f = fakeFetch({
    "POST /tokeninfo": () => jsonResponse({ scope: scopes, expires_in: "3000" }),
    "GET /v1/accounts?": () => jsonResponse(fixture("accounts.json")),
    "GET /apps": (c) => jsonResponse(fixture(c.url.includes("pageToken=page2") ? "apps-page2.json" : "apps-page1.json")),
    "GET /adSources": () => jsonResponse(fixture("ad-sources.json")),
    "GET /mediationGroups": () => jsonResponse(fixture("mediation-groups.json")),
    "GET /services/admob.googleapis.com": () => jsonResponse({ state: "ENABLED" }),
    "GET /services/adsense.googleapis.com": () => jsonResponse({ state: adsense }),
  });
  return { svc: AdmobService.create({ profile: profileName }, { configDir: dir, tokenProvider: token, fetch: f.fetch, sleep: noSleep }), fetch: f.fetch, calls: f.calls };
}

const ALL = "https://www.googleapis.com/auth/admob.readonly https://www.googleapis.com/auth/adsense.readonly https://www.googleapis.com/auth/cloud-platform";

describe("setupStatus", () => {
  it("reports the first failing check's command as next_command", async () => {
    const { svc, fetch, calls } = service("DISABLED", ALL);
    const s = await setupStatus(svc, { fetch });
    expect(s.ok).toBe(false);
    expect(s.next_command).toBe("admobctl setup apis --features payments --yes");
    expect(calls.some((c) => c.url.includes("serviceusage.googleapis.com/v1/projects/example-project/services/adsense.googleapis.com"))).toBe(true);
  });

  it("uses a warning's command when nothing fails", async () => {
    const { svc, fetch } = service("ENABLED", "https://www.googleapis.com/auth/admob.readonly https://www.googleapis.com/auth/cloud-platform");
    const s = await setupStatus(svc, { fetch });
    expect(s.ok).toBe(true);
    expect(s.next_command).toBe("admobctl setup login --features payments --yes");
  });

  it("has no next_command when everything is set up", async () => {
    const { svc, fetch } = service("ENABLED", ALL);
    const s = await setupStatus(svc, { fetch });
    expect(s.ok).toBe(true);
    expect(s.checks.find((c) => c.id === "apis")!.status).toBe("ok");
    expect(s.next_command).toBeUndefined();
  });
});

it("fix commands preserve a named profile instead of modifying default", async () => {
  const { svc, fetch } = service("DISABLED", ALL, "work");
  const s = await setupStatus(svc, { fetch });
  expect(s.next_command).toBe("admobctl --profile work setup apis --features payments --yes");
  expect(s.checks.find((c) => c.id === "apis")!.fix_command).toBe(s.next_command);
});
