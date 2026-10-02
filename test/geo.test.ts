import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli/program.js";
import type { TokenProvider } from "../src/core/auth/types.js";
import { analyzeGeo } from "../src/core/geo.js";
import { AdmobService } from "../src/core/service.js";
import { fakeFetch, fixture, jsonResponse, noSleep, synthReport, type RecordedCall } from "./helpers.js";

const token: TokenProvider = { mode: "adc", getToken: async () => "t", quotaProject: () => "qp" };
type Row = Parameters<typeof synthReport>[0][number];
const cell = (country: string, format: string, earnings: number, requests: number, matched: number, impressions: number): Row => [
  { COUNTRY: [country], FORMAT: [format] },
  { ESTIMATED_EARNINGS: earnings * 1e6, AD_REQUESTS: requests, MATCHED_REQUESTS: matched, IMPRESSIONS: impressions },
];

function setup(rows: Row[]) {
  const f = fakeFetch({
    "GET /v1/accounts?": () => jsonResponse(fixture("accounts.json")),
    "GET /apps": (c) => jsonResponse(fixture(c.url.includes("pageToken=page2") ? "apps-page2.json" : "apps-page1.json")),
    "POST /networkReport:generate": () => jsonResponse(synthReport(rows)),
  });
  const deps = { configDir: mkdtempSync(join(tmpdir(), "admobctl-geo-")), tokenProvider: token, fetch: f.fetch, sleep: noSleep, now: () => new Date("2026-10-02T08:00:00Z") };
  return { svc: AdmobService.create({}, deps), deps, calls: f.calls };
}

const rows = [
  cell("NO", "banner", 60, 40_000, 36_000, 30_000), // eCPM 2.00, 90% match
  cell("SE", "banner", 20, 40_000, 12_000, 10_000), // eCPM 2.00, 30% match: low fill on a big cell
  cell("US", "banner", 12, 2_000, 1_800, 1_500), // eCPM 8.00 on 2.4% of banner requests: an opportunity
  cell("NO", "interstitial", 50, 5_000, 4_500, 2_500), // eCPM 20.00
  cell("DK", "banner", 0.1, 300, 280, 250), // too little traffic to judge
];

describe("analyzeGeo", () => {
  it("asks for country by format, optionally for one app", async () => {
    const { svc, calls } = setup(rows);
    await analyzeGeo(svc, { last: 30, app: "example-quiz-ios" });
    const spec = (calls.find((c: RecordedCall) => c.url.includes("networkReport"))!.body as { reportSpec: { dimensions: string[]; dimensionFilters?: unknown } }).reportSpec;
    expect(spec.dimensions).toEqual(["COUNTRY", "FORMAT"]);
    expect(spec.dimensionFilters).toEqual([{ dimension: "APP", matchesAny: { values: ["ca-app-pub-0000000000000001~1111111111"] } }]);
  });

  it("returns each cell with its share, rates and eCPM against the format", async () => {
    const r = await analyzeGeo(setup(rows).svc, { last: 30 });
    expect(r).toMatchObject({ from: "2026-09-02", to: "2026-10-01", currency: "NOK", estimate: true });
    expect(r.rows.map((x) => `${x.country}/${x.format}`)).toEqual(["NO/banner", "NO/interstitial", "SE/banner", "US/banner", "DK/banner"]);
    expect(r.rows[0]).toMatchObject({ earnings: 60, requests: 40_000, match_rate: 0.9, ecpm: 2, enough_data: true });
    expect(r.rows[0]!.earnings_share).toBeCloseTo(60 / 142.1);
    expect(r.rows[0]!.format_request_share).toBeCloseTo(40_000 / 82_300);
    // Banner eCPM overall: 92.1 / 41 750 impressions × 1000 = 2.21.
    expect(r.rows[3]).toMatchObject({ country: "US", ecpm: 8 });
    expect(r.rows[3]!.ecpm_vs_format).toBeCloseTo(8 / (92.1 / 41.75), 2);
    expect(r.rows[4]).toMatchObject({ country: "DK", enough_data: false });
  });

  it("sums up per country", async () => {
    const r = await analyzeGeo(setup(rows).svc, { last: 30 });
    expect(r.countries.map((c) => c.country)).toEqual(["NO", "SE", "US", "DK"]);
    expect(r.countries[0]).toMatchObject({ earnings: 110, requests: 45_000, ecpm: 3.38 });
    expect(r.countries[0]!.earnings_share).toBeCloseTo(110 / 142.1);
  });

  it("highlights low fill on big cells, high-eCPM cells with little traffic, and concentration", async () => {
    const r = await analyzeGeo(setup(rows).svc, { last: 30 });
    expect(r.highlights.map((h) => `${h.kind}:${h.label}`)).toEqual(["concentration:NO", "low-fill:SE banner", "high-ecpm:US banner"]);
    expect(r.highlights[1]!.message).toMatch(/SE banner fills 30\.0% of 40000 requests; banner fills 90\.0% elsewhere/);
    expect(r.highlights[2]!.message).toMatch(/US banner pays eCPM 8\.00 NOK, 3\.6× the banner average/);
    expect(r.notices.join(" ")).toMatch(/1 of 5 country and format rows had fewer than 1000 requests/);
  });

  it("takes the traffic threshold from the caller", async () => {
    const r = await analyzeGeo(setup(rows).svc, { last: 30, minRequests: 100 });
    expect(r.rows.every((x) => x.enough_data)).toBe(true);
    await expect(analyzeGeo(setup(rows).svc, { minRequests: 0 })).rejects.toThrow(/min-requests/);
  });

  it("says so when there is no traffic", async () => {
    const r = await analyzeGeo(setup([]).svc, { last: 30 });
    expect(r.rows).toEqual([]);
    expect(r.summary[0]).toMatch(/No ad traffic/);
  });
});

describe("cli analyze geo", () => {
  it("prints the cells as a table", async () => {
    const { deps } = setup(rows);
    let stdout = "";
    const code = await run(["node", "admobctl", "analyze", "geo"], { stdout: (s) => (stdout += s), stderr: () => {}, isTTY: true, service: deps });
    expect(code).toBe(0);
    expect(stdout).toMatch(/NO\s+banner\s+60\.00/);
    expect(stdout).toMatch(/DK\s+banner.*thin/);
  });
});
