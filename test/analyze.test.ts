import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeConsent, analyzeVersions, analyzeWaterfall } from "../src/core/analyze.js";
import { API_MAX_ROWS } from "../src/core/report.js";
import { AdmobService } from "../src/core/service.js";
import type { TokenProvider } from "../src/core/auth/types.js";
import { fakeFetch, fixture, jsonResponse, noSleep, synthReport, type RecordedCall } from "./helpers.js";

const token: TokenProvider = { mode: "adc", getToken: async () => "t", quotaProject: () => "qp" };

type Dims = Record<string, [value: string, label?: string]>;
type Metrics = Record<string, number>;

function service(routes: Parameters<typeof fakeFetch>[0]) {
  const dir = mkdtempSync(join(tmpdir(), "admobctl-analyze-"));
  const f = fakeFetch({
    "GET /v1/accounts?": () => jsonResponse(fixture("accounts.json")),
    "GET /apps": (c) => jsonResponse(fixture(c.url.includes("pageToken=page2") ? "apps-page2.json" : "apps-page1.json")),
    ...routes,
  });
  const svc = AdmobService.create({}, { configDir: dir, tokenProvider: token, fetch: f.fetch, sleep: noSleep, now: () => new Date("2026-10-02T08:00:00Z") });
  return { svc, calls: f.calls };
}

const spec = (c: RecordedCall) => (c.body as { reportSpec: { dimensions: string[]; metrics: string[]; dimensionFilters?: unknown } }).reportSpec;

describe("analyzeVersions", () => {
  const r = (platform: string, version: string, req: number, matched: number, imp: number): [Dims, Metrics] => [
    { PLATFORM: [platform, platform === "IOS" ? "iOS" : "Android"], GMA_SDK_VERSION: [version] },
    { AD_REQUESTS: req, MATCHED_REQUESTS: matched, IMPRESSIONS: imp, CLICKS: Math.round(imp / 100) },
  ];
  const rows = [
    r("IOS", "ios-11.10.0", 80_000, 72_000, 60_000),
    r("IOS", "ios-11.12.0", 20_000, 18_000, 7_000), // show rate collapses on the new SDK
    r("ANDROID", "afma-sdk-a-v24", 50_000, 45_000, 40_000),
    r("ANDROID", "afma-sdk-a-v23", 500, 100, 50), // too little traffic to judge
  ];

  it("asks for traffic metrics only, grouped by platform", async () => {
    const { svc, calls } = service({ "POST /networkReport:generate": () => jsonResponse(synthReport(rows)) });
    await analyzeVersions(svc, { by: "sdk", last: 30 });
    const s = spec(calls.find((c) => c.url.includes("networkReport"))!);
    expect(s.dimensions).toEqual(["PLATFORM", "GMA_SDK_VERSION"]);
    expect(s.metrics).not.toContain("ESTIMATED_EARNINGS");
  });

  it("says when the API cut the report off at its row limit", { timeout: 20_000 }, async () => {
    const many = Array.from({ length: API_MAX_ROWS }, (_, i) => r("IOS", `ios-${i}`, 1, 1, 1));
    const { svc } = service({ "POST /networkReport:generate": () => jsonResponse(synthReport(many)) });
    const res = await analyzeVersions(svc, { by: "sdk", last: 30 });
    expect(res.notices).toContain("The AdMob API returned its maximum of 100000 rows, so some rows are probably missing and totals are too low. Use a shorter range.");
  });

  it("ends the period at yesterday, with a notice", async () => {
    const { svc, calls } = service({ "POST /networkReport:generate": () => jsonResponse(synthReport(rows)) });
    const res = await analyzeVersions(svc, { by: "sdk", from: "2026-09-15", to: "2026-10-15" });
    expect((calls.find((c) => c.url.includes("networkReport"))!.body as { reportSpec: { dateRange: unknown } }).reportSpec.dateRange).toEqual({
      startDate: { year: 2026, month: 9, day: 15 },
      endDate: { year: 2026, month: 10, day: 1 },
    });
    expect(res).toMatchObject({ from: "2026-09-15", to: "2026-10-01" });
    expect(res.notices[0]).toBe("Ends at 2026-10-01 (yesterday) instead of 2026-10-15: today's figures are partial and later days have none.");
  });

  it("compares each version with the rest of its platform and flags regressions", async () => {
    const { svc } = service({ "POST /networkReport:generate": () => jsonResponse(synthReport(rows)) });
    const res = await analyzeVersions(svc, { by: "sdk", last: 30 });
    expect(res.from).toBe("2026-09-02");
    expect(res.rows.map((x) => x.version)).toEqual(["ios-11.10.0", "ios-11.12.0", "afma-sdk-a-v24", "afma-sdk-a-v23"]);
    const bad = res.rows.find((x) => x.version === "ios-11.12.0")!;
    expect(bad.group).toBe("iOS");
    expect(bad.request_share).toBeCloseTo(0.2);
    expect(bad.show_rate).toBeCloseTo(7_000 / 18_000);
    expect(res.highlights.map((h) => [h.kind, h.label])).toEqual([["low-show-rate", "iOS ios-11.12.0"]]);
    expect(res.summary.join(" ")).toMatch(/ios-11\.12\.0.*38\.9%.*83\.3%/);
  });

  it("marks versions with too little traffic to judge and says how many", async () => {
    const { svc } = service({ "POST /networkReport:generate": () => jsonResponse(synthReport(rows)) });
    const res = await analyzeVersions(svc, { by: "sdk", last: 30 });
    expect(res.rows.map((x) => [x.version, x.enough_data])).toEqual([
      ["ios-11.10.0", true],
      ["ios-11.12.0", true],
      ["afma-sdk-a-v24", true],
      ["afma-sdk-a-v23", false],
    ]);
    expect(res.notices.join(" ")).toMatch(/1 of 4 SDK versions .*fewer than 1000 requests.*noise/);
  });

  it("groups app versions by app and filters to one app", async () => {
    const { svc, calls } = service({
      "POST /networkReport:generate": () =>
        jsonResponse(synthReport([[{ APP: ["ca-app-pub-0000000000000001~1111111111", "Example Quiz"], APP_VERSION_NAME: ["2.0"] }, { AD_REQUESTS: 10 }]])),
    });
    const res = await analyzeVersions(svc, { by: "app", app: "example-quiz-ios", last: 7 });
    const s = spec(calls.find((c) => c.url.includes("networkReport"))!);
    expect(s.dimensions).toEqual(["APP", "APP_VERSION_NAME"]);
    expect(s.dimensionFilters).toEqual([{ dimension: "APP", matchesAny: { values: ["ca-app-pub-0000000000000001~1111111111"] } }]);
    expect(res.rows[0]!.group).toBe("example-quiz-ios");
  });
});

describe("analyzeConsent", () => {
  const QUIZ_IOS: [string, string] = ["ca-app-pub-0000000000000001~1111111111", "Example Quiz"];
  const QUIZ_ANDROID: [string, string] = ["ca-app-pub-0000000000000001~2222222222", "Example Quiz"];
  const r = (app: [string, string], value: string, label: string, earn: number, req: number, imp: number): [Dims, Metrics] => [
    { APP: app, SERVING_RESTRICTION: [value, label] },
    { ESTIMATED_EARNINGS: earn, AD_REQUESTS: req, MATCHED_REQUESTS: Math.round(req * 0.9), IMPRESSIONS: imp, CLICKS: 0 },
  ];
  const rows = [
    r(QUIZ_IOS, "NONE", "No restriction", 80_000_000, 60_000, 40_000),
    r(QUIZ_IOS, "NPA", "Non-personalized ads", 10_000_000, 30_000, 20_000),
    r(QUIZ_IOS, "LTD", "Limited ads", 1_000_000, 10_000, 5_000),
  ];

  it("shows each serving restriction's share of the app's traffic and its eCPM against the app's unrestricted traffic", async () => {
    const { svc, calls } = service({ "POST /networkReport:generate": () => jsonResponse(synthReport(rows)) });
    const res = await analyzeConsent(svc, { last: 30 });
    expect(spec(calls.find((c) => c.url.includes("networkReport"))!).dimensions).toEqual(["APP", "SERVING_RESTRICTION"]);
    expect(res.restricted_request_share).toBeCloseTo(0.4);
    const npa = res.rows.find((x) => x.restriction === "Non-personalized ads")!;
    expect(npa.app).toBe("example-quiz-ios");
    expect(npa.request_share).toBeCloseTo(0.3);
    expect(npa.ecpm).toBe(0.5);
    expect(npa.ecpm_vs_unrestricted).toBeCloseTo(0.25);
    expect(res.apps).toEqual([{ app: "example-quiz-ios", requests: 100_000, restricted_request_share: 0.4 }]);
    expect(res.summary.join(" ")).toMatch(/40\.0% of ad requests.*restricted/);
    expect(res.summary.join(" ")).toMatch(/example-quiz-ios: Non-personalized ads.*eCPM 0\.50 NOK.*-75%/);
  });

  it("compares restricted traffic within each app, not across apps with different eCPMs", async () => {
    // Account-wide, limited ads look 78% worse per impression; within each app they are 10% worse.
    const mixed = [
      r(QUIZ_IOS, "NONE", "No restriction", 9_000_000, 10_000, 9_000), // eCPM 1.00
      r(QUIZ_IOS, "LTD", "Limited ads", 81_000_000, 100_000, 90_000), // eCPM 0.90
      r(QUIZ_ANDROID, "NONE", "No restriction", 900_000_000, 99_000, 90_000), // eCPM 10.00
      r(QUIZ_ANDROID, "LTD", "Limited ads", 81_000_000, 10_000, 9_000), // eCPM 9.00
    ];
    const { svc } = service({ "POST /networkReport:generate": () => jsonResponse(synthReport(mixed)) });
    const res = await analyzeConsent(svc, { last: 30 });
    expect(res.rows.map((x) => [x.app, x.restriction_id])).toEqual([
      ["example-quiz-ios", "LTD"],
      ["example-quiz-ios", "NONE"],
      ["example-quiz-android", "NONE"],
      ["example-quiz-android", "LTD"],
    ]);
    expect(res.highlights.map((h) => h.message)).toEqual([
      expect.stringMatching(/^example-quiz-ios: Limited ads: 90\.9% of requests at eCPM 0\.90 NOK vs 1\.00 unrestricted \(-10%\)/),
      expect.stringMatching(/^example-quiz-android: Limited ads: 9\.2% of requests at eCPM 9\.00 NOK vs 10\.00 unrestricted \(-10%\)/),
    ]);
    expect(res.apps.map((a) => [a.app, a.restricted_request_share])).toEqual([
      ["example-quiz-ios", expect.closeTo(0.909, 3)],
      ["example-quiz-android", expect.closeTo(0.0917, 3)],
    ]);
    expect(res.summary.join(" ")).not.toMatch(/-7\d%/);
  });

  it("does not judge a comparison when either side has too little traffic", async () => {
    const thin = [
      r(QUIZ_IOS, "NONE", "No restriction", 80_000_000, 60_000, 40_000),
      r(QUIZ_IOS, "LTD", "Limited ads", 10_000_000, 30_000, 20_000),
      r(QUIZ_ANDROID, "NONE", "No restriction", 50_000, 18, 10), // no usable baseline
      r(QUIZ_ANDROID, "LTD", "Limited ads", 4_000_000, 5_000, 4_000),
    ];
    const { svc } = service({ "POST /networkReport:generate": () => jsonResponse(synthReport(thin)) });
    const res = await analyzeConsent(svc, { last: 30 });
    expect(res.highlights.map((h) => h.key)).toEqual(["example-quiz-ios/LTD"]);
    expect(res.rows.filter((x) => x.app === "example-quiz-android").map((x) => x.enough_data)).toEqual([false, false]);
    expect(res.rows.filter((x) => x.app === "example-quiz-ios").map((x) => x.enough_data)).toEqual([true, true]);
    expect(res.notices.join(" ")).toMatch(/2 of 4 rows .*fewer than 1000 requests.*noise/);
  });

  it("notes that serving-restriction data starts in March 2021", async () => {
    const { svc } = service({ "POST /networkReport:generate": () => jsonResponse(synthReport(rows)) });
    const res = await analyzeConsent(svc, { from: "2021-01", to: "2021-06" });
    expect(res.notices.join(" ")).toMatch(/2021-03-13/);
  });
});

describe("analyzeWaterfall", () => {
  const line = (group: string, source: string, instance: string, earn: number, req: number, matched: number, imp: number, ecpm: number): [Dims, Metrics] => [
    { MEDIATION_GROUP: [`g-${group}`, group], AD_SOURCE: [`s-${source}`, source], AD_SOURCE_INSTANCE: [`i-${instance}`, instance] },
    { ESTIMATED_EARNINGS: earn, AD_REQUESTS: req, MATCHED_REQUESTS: matched, IMPRESSIONS: imp, OBSERVED_ECPM: ecpm },
  ];
  const rows = [
    line("Banners", "AdMob Network", "AdMob (default)", 50_000_000, 100_000, 90_000, 80_000, 625_000),
    line("Banners", "Example Bidder", "Bidder floor 1", 30_000_000, 100_000, 20_000, 15_000, 2_000_000),
    line("Banners", "Example Waterfall", "Waterfall 3.00", 0, 40_000, 0, 0, 0), // idle line
    line("Interstitials", "AdMob Network", "AdMob (default)", 90_000_000, 10_000, 9_000, 8_000, 11_250_000),
  ];

  it("lists each group's lines by observed eCPM with their share of the group's earnings", async () => {
    const { svc, calls } = service({ "POST /mediationReport:generate": () => jsonResponse(synthReport(rows)) });
    const res = await analyzeWaterfall(svc, { last: 30 });
    expect(spec(calls.find((c) => c.url.includes("mediationReport"))!).dimensions).toEqual(["MEDIATION_GROUP", "AD_SOURCE", "AD_SOURCE_INSTANCE"]);
    expect(res.rows.map((x) => [x.group, x.instance])).toEqual([
      ["Interstitials", "AdMob (default)"],
      ["Banners", "Bidder floor 1"],
      ["Banners", "AdMob (default)"],
      ["Banners", "Waterfall 3.00"],
    ]);
    const bidder = res.rows[1]!;
    expect(bidder.ecpm).toBe(2);
    expect(bidder.earnings_share).toBeCloseTo(0.375);
    expect(bidder.match_rate).toBeCloseTo(0.2);
    expect(res.highlights.find((h) => h.kind === "idle")?.label).toBe("Banners / Waterfall 3.00");
    expect(res.groups.map((g) => [g.group, g.earnings])).toEqual([
      ["Interstitials", 90],
      ["Banners", 80],
    ]);
  });

  it("filters to one mediation group by name", async () => {
    const { svc } = service({ "POST /mediationReport:generate": () => jsonResponse(synthReport(rows)) });
    const res = await analyzeWaterfall(svc, { last: 30, group: "banners" });
    expect(new Set(res.rows.map((x) => x.group))).toEqual(new Set(["Banners"]));
  });

  it("flags the third-party reporting delay for recent days", async () => {
    const { svc } = service({ "POST /mediationReport:generate": () => jsonResponse(synthReport(rows)) });
    const res = await analyzeWaterfall(svc, { last: 30 });
    expect(res.notices.join(" ")).toMatch(/Third-party/);
  });
});
