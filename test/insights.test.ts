import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeConsent, analyzeVersions, analyzeWaterfall } from "../src/core/analyze.js";
import { analyzeGeo } from "../src/core/geo.js";
import { insights } from "../src/core/insights.js";
import { lint } from "../src/core/lint.js";
import { analyzeTrend } from "../src/core/trend.js";
import { AdmobService } from "../src/core/service.js";
import type { TokenProvider } from "../src/core/auth/types.js";
import { fakeFetch, fixture, jsonResponse, noSleep, type RecordedCall } from "./helpers.js";

const token: TokenProvider = { mode: "adc", getToken: async () => "t", quotaProject: () => "qp" };

type Unit = { id: string; label: string; earn: number; req: number; matched: number; imp: number; clicks: number };

function report(units: Unit[]) {
  return [
    { header: { localizationSettings: { currencyCode: "NOK" }, reportingTimeZone: "Europe/Oslo" } },
    ...units.map((u) => ({
      row: {
        dimensionValues: { AD_UNIT: { value: u.id, displayLabel: u.label } },
        metricValues: {
          ESTIMATED_EARNINGS: { microsValue: String(u.earn) },
          AD_REQUESTS: { integerValue: String(u.req) },
          MATCHED_REQUESTS: { integerValue: String(u.matched) },
          IMPRESSIONS: { integerValue: String(u.imp) },
          CLICKS: { integerValue: String(u.clicks) },
        },
      },
    })),
    { footer: { matchingRowCount: String(units.length) } },
  ];
}

// Current period (2026-09-02 → 2026-10-01).
const current: Unit[] = [
  { id: "u/1", label: "Quiz banner", earn: 60_000_000, req: 20_000, matched: 19_000, imp: 15_000, clicks: 150 },
  { id: "u/2", label: "Quiz interstitial", earn: 30_000_000, req: 40_000, matched: 8_000, imp: 6_000, clicks: 60 }, // low fill
  { id: "u/3", label: "Timer banner", earn: 10_000_000, req: 5_000, matched: 4_900, imp: 1_500, clicks: 5 }, // low show rate
];
// Previous period (2026-08-03 → 2026-09-01).
const previous: Unit[] = [
  { id: "u/1", label: "Quiz banner", earn: 30_000_000, req: 18_000, matched: 17_000, imp: 14_000, clicks: 120 }, // doubled since
  { id: "u/2", label: "Quiz interstitial", earn: 31_000_000, req: 39_000, matched: 8_100, imp: 6_100, clicks: 61 },
  { id: "u/3", label: "Timer banner", earn: 10_500_000, req: 5_100, matched: 5_000, imp: 1_600, clicks: 6 },
];

function service(cur: Unit[] = current, prev: Unit[] = previous) {
  const dir = mkdtempSync(join(tmpdir(), "admobctl-ins-"));
  const f = fakeFetch({
    "GET /v1/accounts?": () => jsonResponse(fixture("accounts.json")),
    "GET /apps": (c) => jsonResponse(fixture(c.url.includes("pageToken=page2") ? "apps-page2.json" : "apps-page1.json")),
    "GET /adUnits": () => jsonResponse(fixture("ad-units.json")),
    "POST /networkReport:generate": (c: RecordedCall) => {
      const spec = (c.body as { reportSpec: { dateRange: { startDate: { month: number } } } }).reportSpec;
      return jsonResponse(report(spec.dateRange.startDate.month === 9 ? cur : prev));
    },
  });
  const svc = AdmobService.create(
    {},
    { configDir: dir, tokenProvider: token, fetch: f.fetch, sleep: noSleep, now: () => new Date("2026-10-02T08:00:00Z") },
  );
  return { svc, calls: f.calls };
}

describe("insights", () => {
  it("compares the last 30 days with the 30 days before", async () => {
    const { svc, calls } = service();
    const r = await insights(svc, { last: 30, by: "ad-unit" });
    const ranges = calls
      .filter((c) => c.url.includes("networkReport"))
      .map((c) => (c.body as { reportSpec: { dateRange: unknown } }).reportSpec.dateRange);
    // The two reports are fetched concurrently, so their order is not fixed.
    expect(ranges).toHaveLength(2);
    expect(ranges).toEqual(
      expect.arrayContaining([
        { startDate: { year: 2026, month: 9, day: 2 }, endDate: { year: 2026, month: 10, day: 1 } },
        { startDate: { year: 2026, month: 8, day: 3 }, endDate: { year: 2026, month: 9, day: 1 } },
      ]),
    );
    expect(r.from).toBe("2026-09-02");
    expect(r.previous.from).toBe("2026-08-03");
    expect(r.totals.earnings).toBe(100);
    expect(r.previous.earnings).toBe(71.5);
    expect(r.totals.change).toBeCloseTo(0.3986, 3);
  });

  it("rejects last days together with from/to instead of silently using one of them", async () => {
    const { svc, calls } = service();
    for (const range of [{ from: "2026-09" }, { to: "2026-09-30" }, { from: "2026-09-01", to: "2026-09-30" }]) {
      await expect(insights(svc, { last: 7, ...range, by: "ad-unit" })).rejects.toMatchObject({ code: "USAGE", message: expect.stringMatching(/not both/) });
    }
    expect(calls).toEqual([]);
  });

  it("rejects last days with from/to before any API call, in every command that takes a range", async () => {
    // The account lookup would fail: the usage error must come first, not this unrelated one.
    const f = fakeFetch({ "GET /v1/accounts?": () => jsonResponse({ error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED" } }, 401) });
    const svc = AdmobService.create({}, { configDir: mkdtempSync(join(tmpdir(), "admobctl-ins-")), tokenProvider: token, fetch: f.fetch, sleep: noSleep });
    const range = { last: 7, from: "2026-09" };
    for (const run of [
      () => insights(svc, { ...range, by: "app" }),
      () => lint(svc, range),
      () => analyzeVersions(svc, { ...range, by: "sdk" }),
      () => analyzeConsent(svc, range),
      () => analyzeWaterfall(svc, range),
      () => analyzeGeo(svc, range),
      () => analyzeTrend(svc, { ...range, by: "app" }),
    ]) {
      await expect(run()).rejects.toMatchObject({ code: "USAGE", message: expect.stringMatching(/not both/) });
    }
    expect(f.calls).toEqual([]);
  });

  it("fetches both reports and the apps list concurrently", async () => {
    // Each request is held until all three (current report, previous report, apps) are in flight.
    // If they are fetched one after another, the first is released by a short fallback timer instead.
    const dir = mkdtempSync(join(tmpdir(), "admobctl-ins-"));
    let inFlight = 0;
    let maxInFlight = 0;
    const held: Array<() => void> = [];
    const releaseAll = () => held.splice(0).forEach((r) => r());
    const gate = (respond: () => Response) =>
      new Promise<Response>((resolve) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        held.push(() => {
          inFlight--;
          resolve(respond());
        });
        if (held.length === 3) releaseAll();
        else setTimeout(releaseAll, 200);
      });
    const f = fakeFetch({
      "GET /v1/accounts?": () => jsonResponse(fixture("accounts.json")),
      "GET /apps": (c) =>
        c.url.includes("pageToken=page2")
          ? jsonResponse(fixture("apps-page2.json"))
          : gate(() => jsonResponse(fixture("apps-page1.json"))),
      "POST /networkReport:generate": (c: RecordedCall) => {
        const spec = (c.body as { reportSpec: { dateRange: { startDate: { month: number } } } }).reportSpec;
        return gate(() => jsonResponse(report(spec.dateRange.startDate.month === 9 ? current : previous)));
      },
    });
    const svc = AdmobService.create(
      {},
      { configDir: dir, tokenProvider: token, fetch: f.fetch, sleep: noSleep, now: () => new Date("2026-10-02T08:00:00Z") },
    );
    await insights(svc, { last: 30, by: "app" });
    expect(maxInFlight).toBe(3);
  });

  it("computes per-row ratios from counts", async () => {
    const { svc } = service();
    const r = await insights(svc, { last: 30, by: "ad-unit" });
    const banner = r.rows.find((x) => x.label === "Quiz banner")!;
    expect(banner.ecpm).toBe(4); // 60 / 15000 * 1000
    expect(banner.request_rpm).toBe(3); // 60 / 20000 * 1000
    expect(banner.match_rate).toBeCloseTo(0.95);
    expect(banner.show_rate).toBeCloseTo(15_000 / 19_000);
    expect(banner.share).toBeCloseTo(0.6);
    expect(banner.change).toBeCloseTo(1.0);
  });

  it("highlights top/bottom earners, low fill, low show rate and swings", async () => {
    const { svc } = service();
    const r = await insights(svc, { last: 30, by: "ad-unit" });
    const kinds = (k: string) => r.highlights.filter((h) => h.kind === k).map((h) => h.label);
    expect(kinds("top")[0]).toBe("Quiz banner");
    expect(kinds("bottom")).toContain("Timer banner");
    expect(kinds("low-fill")).toEqual(["Quiz interstitial"]);
    expect(kinds("low-show-rate")).toEqual(["Timer banner"]);
    expect(kinds("swing-up")).toEqual(["Quiz banner"]);
    expect(kinds("swing-down")).toEqual([]);
  });

  it("writes a plain-language summary with the numbers behind each claim", async () => {
    const { svc } = service();
    const r = await insights(svc, { last: 30, by: "ad-unit" });
    const text = r.summary.join("\n");
    expect(text).toMatch(/100\.00 NOK/);
    expect(text).toMatch(/\+39\.9%/);
    expect(text).toMatch(/Quiz interstitial.*20\.0% match rate.*40000 requests/);
    expect(text).toMatch(/estimated/i);
  });

  it("labels ad units with their app, so same-named units in different apps stay apart", async () => {
    const unit = (id: string, earn: number): Unit => ({ id, label: "ad", earn, req: 1000, matched: 1000, imp: 500, clicks: 5 });
    const { svc } = service(
      [unit("ca-app-pub-0000000000000001/9000000001", 40_000_000), unit("ca-app-pub-0000000000000001/9000000003", 13_000_000)],
      [unit("ca-app-pub-0000000000000001/9000000001", 1_000_000), unit("ca-app-pub-0000000000000001/9000000003", 1_000_000)],
    );
    const r = await insights(svc, { last: 30, by: "ad-unit" });
    expect(r.rows.map((x) => x.label)).toEqual(["example-quiz-ios / ad", "example-quiz-android / ad"]);
    expect(r.summary.join("\n")).toMatch(/example-quiz-android \/ ad rose/);
  });
});
