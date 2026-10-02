import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AdmobClient } from "../src/core/client.js";
import { AdmobService } from "../src/core/service.js";
import type { TokenProvider } from "../src/core/auth/types.js";
import { fakeFetch, fixture, jsonResponse, noSleep, type RecordedCall } from "./helpers.js";

const token: TokenProvider = { mode: "adc", getToken: async () => "t", quotaProject: () => "qp" };
const denied = () =>
  jsonResponse({ error: { code: 403, message: "The caller does not have permission", status: "PERMISSION_DENIED" } }, 403);

const routes = {
  "GET /v1/accounts?": () => jsonResponse(fixture("accounts.json")),
  "GET /v1/accounts/pub-0000000000000001/apps": (c: RecordedCall) =>
    jsonResponse(fixture(c.url.includes("pageToken=page2") ? "apps-page2.json" : "apps-page1.json")),
  "GET /v1/accounts/pub-0000000000000001/adUnits": () => jsonResponse(fixture("ad-units.json")),
  "GET /v1beta/accounts/pub-0000000000000001/adSources?": () => jsonResponse(fixture("ad-sources.json")),
  "GET /adSources/1000000000000000001/adapters": () => jsonResponse(fixture("adapters.json")),
  "GET /v1beta/accounts/pub-0000000000000001/mediationGroups": () => jsonResponse(fixture("mediation-groups.json")),
  "GET /v1beta/accounts/pub-0000000000000001/adUnits/9000000001/adUnitMappings": () => jsonResponse(fixture("ad-unit-mappings.json")),
  "POST /v1beta/accounts/pub-0000000000000001/campaignReport:generate": () => jsonResponse(fixture("campaign-report.json")),
};

function service(extra: Parameters<typeof fakeFetch>[0] = {}) {
  const f = fakeFetch({ ...routes, ...extra });
  const svc = AdmobService.create(
    {},
    { configDir: mkdtempSync(join(tmpdir(), "admobctl-beta-")), tokenProvider: token, fetch: f.fetch, sleep: noSleep, now: () => new Date("2026-10-02T08:00:00Z") },
  );
  return { svc, calls: f.calls };
}

describe("AdmobClient v1beta", () => {
  it("calls v1beta for ad sources and keeps v1 for the stable methods", async () => {
    const f = fakeFetch(routes);
    const client = new AdmobClient({ getToken: async () => "t", fetch: f.fetch, sleep: noSleep });
    const sources = await client.listAdSources("pub-0000000000000001");
    expect(sources.map((s) => s.title)).toEqual(["AdMob Network", "Example Bidder", "Example Waterfall"]);
    await client.listApps("pub-0000000000000001");
    expect(f.calls[0]!.url).toMatch(/^https:\/\/admob\.googleapis\.com\/v1beta\/accounts\/pub-0000000000000001\/adSources\?/);
    expect(f.calls[1]!.url).toMatch(/\/v1\/accounts\/pub-0000000000000001\/apps\?/);
  });

  it("explains that v1beta methods may need Google allowlisting when access is denied", async () => {
    const f = fakeFetch({ "GET /mediationGroups": denied });
    const client = new AdmobClient({ getToken: async () => "t", fetch: f.fetch, sleep: noSleep });
    const err = await client.listMediationGroups("pub-1").catch((e) => e);
    expect(err.code).toBe("BETA_ACCESS_DENIED");
    expect(err.message).toMatch(/mediationGroups\.list/);
    expect(err.fix).toMatch(/account manager/);
  });

  it("passes a mediation group filter through", async () => {
    const f = fakeFetch(routes);
    const client = new AdmobClient({ getToken: async () => "t", fetch: f.fetch, sleep: noSleep });
    await client.listMediationGroups("pub-0000000000000001", 'IN(FORMAT, "BANNER")');
    expect(new URL(f.calls[0]!.url).searchParams.get("filter")).toBe('IN(FORMAT, "BANNER")');
  });
});

describe("AdmobService v1beta reads", () => {
  it("lists adapters for an ad source given by name", async () => {
    const { svc, calls } = service();
    const adapters = await svc.adapters("example bidder");
    expect(adapters.map((a) => a.title)).toEqual(["Example Bidder (iOS)", "Example Bidder (Android)"]);
    expect(adapters[0]).toMatchObject({ adSource: "Example Bidder", platform: "IOS", formats: ["BANNER", "INTERSTITIAL"] });
    expect(adapters[0]!.settings).toEqual([
      { id: "3000000001", label: "Placement ID", required: true },
      { id: "3000000002", label: "Reporting key", required: false },
    ]);
    expect(calls.some((c) => c.url.includes("/adSources/1000000000000000001/adapters"))).toBe(true);
  });

  it("rejects an unknown ad source, listing the known ones", async () => {
    const { svc } = service();
    await expect(svc.adapters("nope")).rejects.toThrow(/AdMob Network, Example Bidder, Example Waterfall/);
  });

  it("lists mediation groups with readable lines and A/B state", async () => {
    const { svc } = service();
    const groups = await svc.mediationGroups();
    expect(groups.map((g) => [g.name, g.experiment])).toEqual([
      ["Banners", "none"],
      ["Interstitials", "running"],
    ]);
    const banners = groups[0]!;
    expect(banners).toMatchObject({ id: "1000000001", state: "ENABLED", platform: "IOS", format: "BANNER", regions: ["NO", "SE"] });
    expect(banners.adUnits).toEqual([{ adUnitId: "ca-app-pub-0000000000000001/9000000001", name: "Quiz banner", app: "example-quiz-ios" }]);
    expect(banners.lines.map((l) => [l.name, l.adSource, l.cpmMode, l.cpm])).toEqual([
      ["AdMob Network", "AdMob Network", "LIVE", undefined],
      ["Bidder floor 1", "Example Bidder", "LIVE", undefined],
      ["Waterfall 3.00", "Example Waterfall", "MANUAL", 3],
    ]);
    expect(groups[1]!.lines.map((l) => l.variant)).toEqual(["A", "B"]);
  });

  it("builds the mediation group filter from app, ad source, format, platform and state", async () => {
    const { svc, calls } = service();
    await svc.mediationGroups({ app: "example-quiz-ios", adSource: "Example Bidder", format: "banner", platform: "ios", state: "enabled" });
    const filter = new URL(calls.find((c) => c.url.includes("mediationGroups"))!.url).searchParams.get("filter");
    expect(filter).toBe(
      'CONTAINS_ANY(APP_IDS, "ca-app-pub-0000000000000001~1111111111") AND CONTAINS_ANY(AD_SOURCE_IDS, "1000000000000000001") AND IN(FORMAT, "BANNER") AND IN(PLATFORM, "IOS") AND IN(STATE, "ENABLED")',
    );
  });

  it("lists the ad unit mappings of an ad unit given by name", async () => {
    const { svc } = service();
    const m = await svc.adUnitMappings("Quiz banner");
    expect(m).toEqual([
      {
        id: "5000000001",
        name: "Quiz banner - Example Bidder",
        adUnit: "Quiz banner",
        adUnitId: "ca-app-pub-0000000000000001/9000000001",
        adapterId: "2000000001",
        state: "ENABLED",
        settings: { "3000000001": "placement-quiz-banner" },
        resource: "accounts/pub-0000000000000001/adUnits/9000000001/adUnitMappings/5000000001",
      },
    ]);
  });
});

describe("campaign report", () => {
  it("returns friendly rows with cost in micros and totals that recompute CTR and CPI", async () => {
    const { svc, calls } = service();
    const r = await svc.campaignReport({ from: "2026-09-01", to: "2026-09-30", by: ["campaign"] });
    const body = calls.find((c) => c.url.includes("campaignReport"))!.body as { reportSpec: Record<string, unknown> };
    expect(body.reportSpec.dimensions).toEqual(["CAMPAIGN_NAME"]);
    expect(body.reportSpec.metrics).toEqual(["IMPRESSIONS", "CLICKS", "CLICK_THROUGH_RATE", "INSTALLS", "ESTIMATED_COST", "AVERAGE_CPI"]);
    expect(r.kind).toBe("campaign");
    expect(r.rows[0]).toMatchObject({ campaign_name: "Quiz cross-promo", installs: 40, cost: 80, cost_micros: 80_000_000, cpi: 2 });
    expect(r.totals).toMatchObject({ impressions: 60_000, clicks: 550, installs: 45, cost_micros: 95_000_000 });
    expect(r.totals!.cpi).toBeCloseTo(2.11, 2);
    expect(r.totals!.ctr).toBeCloseTo(550 / 60_000);
  });

  it("splits ranges longer than 30 days and adds up the chunks", async () => {
    const { svc, calls } = service();
    const r = await svc.campaignReport({ from: "2026-07-01", to: "2026-09-30", by: ["campaign"] });
    const ranges = calls
      .filter((c) => c.url.includes("campaignReport"))
      .map((c) => (c.body as { reportSpec: { dateRange: { startDate: { month: number; day: number }; endDate: { month: number; day: number } } } }).reportSpec.dateRange);
    expect(ranges.map((d) => `${d.startDate.month}/${d.startDate.day}-${d.endDate.month}/${d.endDate.day}`)).toEqual([
      "7/1-7/30",
      "7/31-8/29",
      "8/30-9/28",
      "9/29-9/30",
    ]);
    // Each chunk returns the same two campaigns: their totals add up, ratios are recomputed.
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({ campaign_name: "Quiz cross-promo", impressions: 200_000, installs: 160, cost_micros: 320_000_000, cpi: 2 });
    expect(r.notices.join(" ")).toMatch(/4 requests of at most 30 days/);
  });

  it("concatenates chunks when the report is by date", async () => {
    const day = (d: string) => ({ dimensionValues: { DATE: { value: d } }, metricValues: { INSTALLS: { integerValue: "1" } } });
    const { svc } = service({
      "POST /v1beta/accounts/pub-0000000000000001/campaignReport:generate": (c) => {
        const start = (c.body as { reportSpec: { dateRange: { startDate: { month: number } } } }).reportSpec.dateRange.startDate.month;
        return jsonResponse({ rows: start === 8 ? [day("20260815")] : [day("20260901")] });
      },
    });
    const r = await svc.campaignReport({ from: "2026-08-15", to: "2026-09-20", by: ["date"], metrics: ["installs"] });
    expect(r.rows.map((x) => x.date)).toEqual(["2026-08-15", "2026-09-01"]);
  });

  it("rejects network-only dimensions", async () => {
    const { svc } = service();
    await expect(svc.campaignReport({ from: "2026-09", by: ["app"] })).rejects.toThrow(/campaign reports/);
  });

  it("explains a bare 400 from campaignReport and names a fix", async () => {
    // Live: a valid spec on an account without app-promotion campaigns gets this with no details.
    const { svc } = service({
      "POST /v1beta/accounts/pub-0000000000000001/campaignReport:generate": () =>
        jsonResponse({ error: { code: 400, message: "Request contains an invalid argument.", status: "INVALID_ARGUMENT" } }, 400),
    });
    const err = await svc.campaignReport({ from: "2026-09", by: ["campaign"] }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "CAMPAIGN_REPORT_REJECTED", status: 400 });
    expect((err as Error).message).toMatch(/campaign report/i);
    expect((err as { fix?: string }).fix).toMatch(/Campaigns/);
  });
});
