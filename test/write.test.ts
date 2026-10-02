import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AdmobService } from "../src/core/service.js";
import {
  applyPlan,
  planAddLine,
  planCreateAdUnit,
  planCreateApp,
  planCreateMapping,
  planCreateMappings,
  planCreateMediationGroup,
  planSetGroupAdUnits,
  planStartExperiment,
  planStopExperiment,
  planUpdateLine,
} from "../src/core/write.js";
import type { TokenProvider } from "../src/core/auth/types.js";
import type { AdmobctlError } from "../src/core/errors.js";
import { fakeFetch, fixture, jsonResponse, noSleep, type RecordedCall } from "./helpers.js";

const token: TokenProvider = { mode: "adc", getToken: async () => "t", quotaProject: () => "qp" };
const PUB = "accounts/pub-0000000000000001";

function service(extra: Parameters<typeof fakeFetch>[0] = {}) {
  const dir = mkdtempSync(join(tmpdir(), "admobctl-write-"));
  const f = fakeFetch({
    "GET /v1/accounts?": () => jsonResponse(fixture("accounts.json")),
    "GET /v1/accounts/pub-0000000000000001/apps": (c: RecordedCall) =>
      jsonResponse(fixture(c.url.includes("pageToken=page2") ? "apps-page2.json" : "apps-page1.json")),
    "GET /v1/accounts/pub-0000000000000001/adUnits": () => jsonResponse(fixture("ad-units.json")),
    "GET /v1beta/accounts/pub-0000000000000001/adSources?": () => jsonResponse(fixture("ad-sources.json")),
    "GET /adSources/1000000000000000001/adapters": () => jsonResponse(fixture("adapters.json")),
    "GET /v1beta/accounts/pub-0000000000000001/mediationGroups": () => jsonResponse(fixture("mediation-groups.json")),
    ...extra,
  });
  const svc = AdmobService.create({}, { configDir: dir, tokenProvider: token, fetch: f.fetch, sleep: noSleep, now: () => new Date("2026-10-02T08:00:00Z") });
  return { svc, calls: f.calls, dir };
}

describe("write plans (nothing is sent until applied)", () => {
  it("plans an app: linked to a store, or manual with a name", async () => {
    const { svc, calls } = service();
    const linked = await planCreateApp(svc, { platform: "android", storeId: "com.example.new" });
    expect(linked).toMatchObject({ method: "POST", path: `${PUB}/apps`, body: { platform: "ANDROID", linkedAppInfo: { appStoreId: "com.example.new" } } });
    const manual = await planCreateApp(svc, { platform: "ios", name: "New Game" });
    expect(manual.body).toEqual({ platform: "IOS", manualAppInfo: { displayName: "New Game" } });
    await expect(planCreateApp(svc, { platform: "ios" })).rejects.toThrow(/--name or --store-id/);
    await expect(planCreateApp(svc, { platform: "web", name: "x" })).rejects.toThrow(/ios or android/);
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
  });

  it("plans an ad unit, resolving the app alias and checking format rules", async () => {
    const { svc } = service();
    const p = await planCreateAdUnit(svc, { app: "example-quiz-ios", name: "Level end", format: "rewarded", reward: { amount: 10, item: "coins" } });
    expect(p.body).toEqual({
      appId: "ca-app-pub-0000000000000001~1111111111",
      displayName: "Level end",
      adFormat: "REWARDED",
      rewardSettings: { unitAmount: "10", unitType: "coins" },
    });
    expect(p.summary.join(" ")).toMatch(/example-quiz-ios/);
    await expect(planCreateAdUnit(svc, { app: "example-quiz-ios", name: "x", format: "banner", reward: { amount: 1, item: "c" } })).rejects.toThrow(
      /rewarded/,
    );
    await expect(planCreateAdUnit(svc, { app: "example-quiz-ios", name: "x", format: "rewarded-interstitial", adTypes: ["rich-media"] })).rejects.toThrow(
      /video only/,
    );
    await expect(planCreateAdUnit(svc, { app: "example-quiz-ios", name: "x", format: "banner-interstitial" })).rejects.toThrow(/format/);
  });

  it("plans a mapping, translating setting labels to IDs and checking required settings and platform", async () => {
    const { svc } = service();
    const p = await planCreateMapping(svc, {
      adUnit: "Quiz banner",
      adSource: "Example Bidder",
      adapter: "2000000001",
      name: "Quiz banner - Bidder",
      settings: { "Placement ID": "pl-1" },
    });
    expect(p.path).toBe(`${PUB}/adUnits/9000000001/adUnitMappings`);
    expect(p.body).toEqual({ adapterId: "2000000001", displayName: "Quiz banner - Bidder", adUnitConfigurations: { "3000000001": "pl-1" } });
    await expect(
      planCreateMapping(svc, { adUnit: "Quiz banner", adSource: "Example Bidder", adapter: "2000000001", settings: { "Reporting key": "k" } }),
    ).rejects.toThrow(/Placement ID.*required/);
    // The Android adapter cannot serve an iOS app's ad unit.
    await expect(
      planCreateMapping(svc, { adUnit: "Quiz banner", adSource: "Example Bidder", adapter: "2000000002", settings: { "Placement ID": "x" } }),
    ).rejects.toThrow(/ANDROID.*IOS/);
    await expect(
      planCreateMapping(svc, { adUnit: "Quiz banner", adSource: "Example Bidder", adapter: "2000000001", settings: { "Placement ID": "x", Nope: "y" } }),
    ).rejects.toThrow(/Unknown setting "Nope".*Placement ID, Reporting key/);
  });

  it("splits mapping batches at 100, the API's all-or-nothing limit", async () => {
    const { svc } = service();
    const entries = Array.from({ length: 150 }, (_, i) => ({
      adUnit: "Quiz banner",
      adSource: "Example Bidder",
      adapter: "2000000001",
      name: `m${i}`,
      settings: { "Placement ID": `p${i}` },
    }));
    const plans = await planCreateMappings(svc, entries);
    expect(plans.map((p) => (p.body as { requests: unknown[] }).requests.length)).toEqual([100, 50]);
    expect(plans[0]!.path).toBe(`${PUB}/adUnitMappings:batchCreate`);
    expect((plans[0]!.body as { requests: Array<{ parent: string }> }).requests[0]!.parent).toBe(`${PUB}/adUnits/9000000001`);
  });

  it("plans a mediation group from a file, requiring negative placeholder line IDs", async () => {
    const { svc } = service();
    const group = {
      displayName: "New banners",
      state: "ENABLED",
      targeting: { platform: "IOS", format: "BANNER", adUnitIds: ["ca-app-pub-0000000000000001/9000000001"] },
      mediationGroupLines: { "-1": { displayName: "Bidder", adSourceId: "1000000000000000001", cpmMode: "LIVE", state: "ENABLED" } },
    };
    const p = await planCreateMediationGroup(svc, group);
    expect(p).toMatchObject({ method: "POST", path: `${PUB}/mediationGroups`, body: group });
    await expect(planCreateMediationGroup(svc, { ...group, mediationGroupLines: { "7": group.mediationGroupLines["-1"] } })).rejects.toThrow(
      /negative/,
    );
    await expect(planCreateMediationGroup(svc, { ...group, displayName: "x".repeat(121) })).rejects.toThrow(/120/);
  });

  it("plans line updates with the documented field masks", async () => {
    const { svc } = service();
    const p = await planUpdateLine(svc, { group: "Banners", line: "Waterfall 3.00", cpm: 2.5, state: "disabled" });
    expect(p.method).toBe("PATCH");
    expect(p.path).toBe(`${PUB}/mediationGroups/1000000001`);
    expect(p.query).toEqual({
      updateMask: 'mediation_group_lines["4000000000000003"].cpm_micros,mediation_group_lines["4000000000000003"].state',
    });
    expect(p.body).toEqual({ mediationGroupLines: { "4000000000000003": { cpmMicros: "2500000", state: "DISABLED" } } });
    expect(p.summary.join(" ")).toMatch(/3\.00 → 2\.50 USD/);
    await expect(planUpdateLine(svc, { group: "Banners", line: "Bidder floor 1", cpm: 1 })).rejects.toThrow(/LIVE/);
    await expect(planUpdateLine(svc, { group: "Banners", line: "nope", state: "enabled" })).rejects.toThrow(/Unknown line/);
  });

  it("plans a new line with a negative placeholder ID", async () => {
    const { svc } = service();
    const p = await planAddLine(svc, { group: "Banners", adSource: "Example Waterfall", name: "Waterfall 5.00", cpm: 5 });
    expect(p.query).toEqual({ updateMask: 'mediation_group_lines["-1"]' });
    expect(p.body).toEqual({
      mediationGroupLines: { "-1": { displayName: "Waterfall 5.00", adSourceId: "1000000000000000002", cpmMode: "MANUAL", cpmMicros: "5000000", state: "ENABLED" } },
    });
  });

  it("plans the targeted ad units of a group", async () => {
    const { svc } = service();
    const p = await planSetGroupAdUnits(svc, { group: "Banners", adUnits: ["Quiz banner", "9000000002"] });
    expect(p.query).toEqual({ updateMask: "targeting.ad_unit_ids" });
    expect(p.body).toEqual({ targeting: { adUnitIds: ["ca-app-pub-0000000000000001/9000000001", "ca-app-pub-0000000000000001/9000000002"] } });
  });

  it("plans starting and stopping an A/B experiment", async () => {
    const { svc } = service();
    const start = await planStartExperiment(svc, {
      group: "Banners",
      name: "Floor test",
      percent: 50,
      lines: [{ displayName: "Waterfall 4.00", adSourceId: "1000000000000000002", cpmMode: "MANUAL", cpmMicros: "4000000", state: "ENABLED" }],
    });
    expect(start.path).toBe(`${PUB}/mediationGroups/1000000001/mediationAbExperiments`);
    expect(start.body).toEqual({
      displayName: "Floor test",
      treatmentTrafficPercentage: "50",
      treatmentMediationLines: [{ mediationGroupLine: { displayName: "Waterfall 4.00", adSourceId: "1000000000000000002", cpmMode: "MANUAL", cpmMicros: "4000000", state: "ENABLED" } }],
    });
    await expect(planStartExperiment(svc, { group: "Interstitials", name: "x", percent: 50, lines: [] })).rejects.toThrow(/already running/);
    await expect(planStartExperiment(svc, { group: "Banners", name: "x", percent: 100, lines: [] })).rejects.toThrow(/1 and 99/);

    const stop = await planStopExperiment(svc, { group: "Interstitials", keep: "B" });
    expect(stop).toMatchObject({ method: "POST", path: `${PUB}/mediationGroups/1000000002/mediationAbExperiments:stop`, body: { variantChoice: "VARIANT_CHOICE_B" } });
    await expect(planStopExperiment(svc, { group: "Banners", keep: "A" })).rejects.toThrow(/no A\/B experiment running/);
  });
});

describe("applyPlan", () => {
  it("sends the plan to v1beta and appends an audit line", async () => {
    const { svc, calls, dir } = service({
      "POST /v1beta/accounts/pub-0000000000000001/apps": (c) => jsonResponse({ ...(c.body as object), name: `${PUB}/apps/7777777777`, appId: "ca-app-pub-0000000000000001~7777777777" }),
    });
    const plan = await planCreateApp(svc, { platform: "ios", name: "New Game" });
    const r = await applyPlan(svc, plan);
    expect(r).toMatchObject({ appId: "ca-app-pub-0000000000000001~7777777777" });
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe(`https://admob.googleapis.com/v1beta/${PUB}/apps`);
    const audit = readFileSync(join(dir, "audit.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "Create app", method: "POST", path: `${PUB}/apps`, ok: true, result: `${PUB}/apps/7777777777` });
    expect(statSync(join(dir, "audit.log")).mode & 0o777).toBe(0o600);
  });

  it("sends PATCH with the update mask and audits failures too", async () => {
    const { svc, calls, dir } = service({
      "PATCH /v1beta/accounts/pub-0000000000000001/mediationGroups/1000000001": () =>
        jsonResponse({ error: { code: 403, message: "Request had insufficient authentication scopes.", status: "PERMISSION_DENIED", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } }, 403),
    });
    const plan = await planUpdateLine(svc, { group: "Banners", line: "4000000000000003", state: "disabled" });
    const err = (await applyPlan(svc, plan).catch((e: unknown) => e)) as AdmobctlError;
    expect(err.code).toBe("AUTH_SCOPE_MISSING");
    expect(err.fix).toMatch(/admob\.monetization/);
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(new URL(patch.url).searchParams.get("updateMask")).toBe('mediation_group_lines["4000000000000003"].state');
    const audit = JSON.parse(readFileSync(join(dir, "audit.log"), "utf8").trim());
    expect(audit).toMatchObject({ ok: false, error: "AUTH_SCOPE_MISSING" });
  });

  it("explains allowlisting when a write is denied", async () => {
    const { svc } = service({
      "POST /v1beta/accounts/pub-0000000000000001/adUnits": () =>
        jsonResponse({ error: { code: 403, message: "The caller does not have permission", status: "PERMISSION_DENIED" } }, 403),
    });
    const plan = await planCreateAdUnit(svc, { app: "example-quiz-ios", name: "x", format: "banner" });
    const err = (await applyPlan(svc, plan).catch((e: unknown) => e)) as AdmobctlError;
    expect(err.code).toBe("BETA_ACCESS_DENIED");
    expect(err.message).toMatch(/adUnits\.create/);
  });
});
