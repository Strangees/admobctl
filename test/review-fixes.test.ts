import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeConsent, analyzeWaterfall } from "../src/core/analyze.js";
import type { TokenProvider } from "../src/core/auth/types.js";
import { runDoctor } from "../src/core/auth/doctor.js";
import { AdmobClient } from "../src/core/client.js";
import { AdmobctlError } from "../src/core/errors.js";
import { AdmobService } from "../src/core/service.js";
import { applyPlan, planCreateApp } from "../src/core/write.js";
import { fakeFetch, fixture, jsonResponse, noSleep, synthReport, type RecordedCall } from "./helpers.js";

const token: TokenProvider = { mode: "adc", getToken: async () => "t", quotaProject: () => "qp" };

function service(routes: Parameters<typeof fakeFetch>[0], dir = mkdtempSync(join(tmpdir(), "admobctl-fix-"))) {
  const f = fakeFetch({
    "GET /v1/accounts?": () => jsonResponse(fixture("accounts.json")),
    "GET /apps": (c: RecordedCall) => jsonResponse(fixture(c.url.includes("pageToken=page2") ? "apps-page2.json" : "apps-page1.json")),
    "GET /adUnits?": () => jsonResponse(fixture("ad-units.json")),
    "GET /v1beta/accounts/pub-0000000000000001/adSources?": () => jsonResponse(fixture("ad-sources.json")),
    ...routes,
  });
  const svc = AdmobService.create({}, { configDir: dir, tokenProvider: token, fetch: f.fetch, sleep: noSleep, now: () => new Date("2026-10-02T08:00:00Z") });
  return { svc, calls: f.calls, dir };
}

describe("writes are sent once", () => {
  it("does not retry a write that failed with a 5xx, and says to check before retrying", async () => {
    const f = fakeFetch({ "POST /apps": () => jsonResponse({ error: { code: 503, message: "backend error" } }, 503) });
    const client = new AdmobClient({ getToken: async () => "t", fetch: f.fetch, sleep: noSleep });
    const err = (await client.write("POST", "accounts/pub-1/apps", { platform: "IOS" }).catch((e: unknown) => e)) as AdmobctlError;
    expect(f.calls).toHaveLength(1);
    expect(err.message).toMatch(/may have been applied/);
    expect(err.fix).toMatch(/before retrying/);
  });

  it("says a write may have been applied after a network error, since it may have reached the API", async () => {
    const f = fakeFetch({ "POST /apps": () => Promise.reject(new TypeError("fetch failed")) });
    const client = new AdmobClient({ getToken: async () => "t", fetch: f.fetch, sleep: noSleep });
    const err = (await client.write("POST", "accounts/pub-1/apps", { platform: "IOS" }).catch((e: unknown) => e)) as AdmobctlError;
    expect(f.calls).toHaveLength(1);
    expect(err.message).toMatch(/fetch failed.*may have been applied/);
  });

  it("keeps a sign-in failure's own message and fix: nothing was sent", async () => {
    const f = fakeFetch({});
    const expired = new AdmobctlError("AUTH_TOKEN_EXPIRED", "The saved sign-in has expired.", { fix: "admobctl auth login" });
    const client = new AdmobClient({ getToken: () => Promise.reject(expired), fetch: f.fetch, sleep: noSleep });
    const err = (await client.write("POST", "accounts/pub-1/apps", { platform: "IOS" }).catch((e: unknown) => e)) as AdmobctlError;
    expect(f.calls).toHaveLength(0);
    expect(err.code).toBe("AUTH_TOKEN_EXPIRED");
    expect(err.message).toBe("The saved sign-in has expired.");
    expect(err.fix).toBe("admobctl auth login");
  });

  it("still reports a write that succeeded when the audit log cannot be written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "admobctl-fix-"));
    mkdirSync(join(dir, "audit.log")); // appending to a directory fails with EISDIR
    const { svc } = service(
      { "POST /v1beta/accounts/pub-0000000000000001/apps": () => jsonResponse({ name: "accounts/pub-0000000000000001/apps/7" }) },
      dir,
    );
    const r = await applyPlan(svc, await planCreateApp(svc, { platform: "ios", name: "x" }));
    expect(r).toEqual({ name: "accounts/pub-0000000000000001/apps/7" });
  });
});

describe("mediation group format filter", () => {
  it("maps hyphenated formats to the API's enum names", async () => {
    const { svc, calls } = service({ "GET /v1beta/accounts/pub-0000000000000001/mediationGroups": () => jsonResponse({ mediationGroups: [] }) });
    await svc.mediationGroups({ format: "rewarded-interstitial" });
    const filter = new URL(calls.find((c) => c.url.includes("mediationGroups"))!.url).searchParams.get("filter");
    expect(filter).toBe('IN(FORMAT, "REWARDED_INTERSTITIAL")');
  });
});

describe("analyzeWaterfall grouping", () => {
  it("keeps groups with the same name and earnings apart", async () => {
    const line = (g: string, inst: string, ecpm: number): [Record<string, [string, string?]>, Record<string, number>] => [
      { MEDIATION_GROUP: [g, "Banner"], AD_SOURCE: ["s", "Src"], AD_SOURCE_INSTANCE: [inst, inst] },
      { ESTIMATED_EARNINGS: 0, AD_REQUESTS: 10, MATCHED_REQUESTS: 0, IMPRESSIONS: 0, OBSERVED_ECPM: ecpm },
    ];
    const rows = [line("g1", "a1", 3), line("g2", "b1", 2), line("g1", "a2", 1)];
    const { svc } = service({ "POST /mediationReport:generate": () => jsonResponse(synthReport(rows)) });
    const r = await analyzeWaterfall(svc, { last: 30 });
    expect(r.groups.map((g) => [g.group_id, g.lines])).toEqual([
      ["g1", 2],
      ["g2", 1],
    ]);
  });
});

describe("analyzeConsent precision", () => {
  it("compares eCPMs from micros, not from rounded amounts", async () => {
    const rows: Array<[Record<string, [string, string?]>, Record<string, number>]> = [
      // eCPM 0.015 vs 0.006 → 40%, while rounded amounts (0.02 vs 0.01) would say 50%.
      [{ SERVING_RESTRICTION: ["NONE", "No restriction"] }, { ESTIMATED_EARNINGS: 15_000, AD_REQUESTS: 2000, MATCHED_REQUESTS: 1000, IMPRESSIONS: 1000, CLICKS: 0 }],
      [{ SERVING_RESTRICTION: ["NPA", "Non-personalized ads"] }, { ESTIMATED_EARNINGS: 6_000, AD_REQUESTS: 2000, MATCHED_REQUESTS: 1000, IMPRESSIONS: 1000, CLICKS: 0 }],
    ];
    const { svc } = service({ "POST /networkReport:generate": () => jsonResponse(synthReport(rows)) });
    const r = await analyzeConsent(svc, { last: 30 });
    expect(r.rows.find((x) => x.restriction_id === "NPA")!.ecpm_vs_unrestricted).toBeCloseTo(0.4);
  });
});

describe("auth doctor check list", () => {
  it("lists apps and beta as skipped when an early check fails", async () => {
    const checks = await runDoctor({
      mode: "adc",
      checkCredentials: () => {
        throw new AdmobctlError("AUTH_NO_CREDENTIALS", "none");
      },
      getToken: async () => "t",
      tokenInfo: async () => ({ scopes: [] }),
      quotaProject: "qp",
      listAccounts: async () => [],
      account: async () => Promise.reject(new Error("x")),
      listApps: async () => [],
      betaProbes: { "ad sources": async () => [] },
    });
    expect(checks.map((c) => c.id)).toEqual(["credentials", "token", "scope", "quota-project", "api", "account", "apps", "beta"]);
  });

  it("lists beta as skipped when the account check fails", async () => {
    const checks = await runDoctor({
      mode: "adc",
      checkCredentials: () => undefined,
      getToken: async () => "t",
      tokenInfo: async () => ({ scopes: ["https://www.googleapis.com/auth/admob.readonly"] }),
      quotaProject: "qp",
      listAccounts: async () => [],
      account: async () => Promise.reject(new AdmobctlError("USAGE", "several accounts")),
      listApps: async () => [],
      betaProbes: { "ad sources": async () => [] },
    });
    expect(checks.slice(-2).map((c) => [c.id, c.status])).toEqual([
      ["apps", "skip"],
      ["beta", "skip"],
    ]);
  });
});
