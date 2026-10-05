import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli/program.js";
import type { TokenProvider } from "../src/core/auth/types.js";
import { buildReportSpec, parseSort } from "../src/core/report.js";
import { AdmobService } from "../src/core/service.js";
import { fakeFetch, fixture, jsonResponse, noSleep, synthReport, type RecordedCall } from "./helpers.js";

const token: TokenProvider = { mode: "adc", getToken: async () => "t", quotaProject: () => "qp" };
const sept = { startDate: { year: 2026, month: 9, day: 1 }, endDate: { year: 2026, month: 9, day: 30 } };
const NOW = () => new Date("2026-10-02T08:00:00Z");

type Spec = { dateRange: { startDate: { month: number; day: number }; endDate: { month: number; day: number } }; sortConditions?: unknown; maxReportRows?: number };
const spec = (c: RecordedCall) => (c.body as { reportSpec: Spec }).reportSpec;

/** September is the current period; anything earlier is the previous one. */
function routes() {
  return fakeFetch({
    "GET /v1/accounts?": () => jsonResponse(fixture("accounts.json")),
    "GET /apps": (c) => jsonResponse(fixture(c.url.includes("pageToken=page2") ? "apps-page2.json" : "apps-page1.json")),
    "POST /networkReport:generate": (c) =>
      jsonResponse(
        spec(c).dateRange.startDate.month === 9
          ? synthReport([
              [{ COUNTRY: ["NO"] }, { ESTIMATED_EARNINGS: 60e6, IMPRESSIONS: 12000 }],
              [{ COUNTRY: ["SE"] }, { ESTIMATED_EARNINGS: 30e6, IMPRESSIONS: 6000 }],
              [{ COUNTRY: ["DK"] }, { ESTIMATED_EARNINGS: 5e6, IMPRESSIONS: 1000 }],
            ])
          : synthReport([
              [{ COUNTRY: ["NO"] }, { ESTIMATED_EARNINGS: 40e6, IMPRESSIONS: 10000 }],
              [{ COUNTRY: ["SE"] }, { ESTIMATED_EARNINGS: 60e6, IMPRESSIONS: 6000 }],
              [{ COUNTRY: ["FI"] }, { ESTIMATED_EARNINGS: 9e6, IMPRESSIONS: 900 }],
            ]),
      ),
  });
}

function service() {
  const f = routes();
  const svc = AdmobService.create({}, { configDir: mkdtempSync(join(tmpdir(), "admobctl-cmp-")), tokenProvider: token, fetch: f.fetch, sleep: noSleep, now: NOW });
  return { svc, calls: f.calls };
}

describe("report sort", () => {
  it("parses a field and an optional order; dimensions ascend and metrics descend by default", () => {
    expect(parseSort("impressions", "network", ["COUNTRY"], ["ESTIMATED_EARNINGS", "IMPRESSIONS"])).toEqual({ metric: "IMPRESSIONS", order: "DESCENDING" });
    expect(parseSort("earnings:asc", "network", ["COUNTRY"], ["ESTIMATED_EARNINGS"])).toEqual({ metric: "ESTIMATED_EARNINGS", order: "ASCENDING" });
    expect(parseSort("country", "network", ["COUNTRY"], ["ESTIMATED_EARNINGS"])).toEqual({ dimension: "COUNTRY", order: "ASCENDING" });
    expect(parseSort("ad-source:desc", "mediation", ["AD_SOURCE"], ["ESTIMATED_EARNINGS"])).toEqual({ dimension: "AD_SOURCE", order: "DESCENDING" });
  });

  it("rejects a field that is not in the report, and a bad order", () => {
    expect(() => parseSort("clicks", "network", ["COUNTRY"], ["ESTIMATED_EARNINGS"])).toThrow(/not in this report.*country, earnings/);
    expect(() => parseSort("earnings:up", "network", ["COUNTRY"], ["ESTIMATED_EARNINGS"])).toThrow(/asc or desc/);
    expect(() => parseSort("nonsense", "network", ["COUNTRY"], ["ESTIMATED_EARNINGS"])).toThrow(/not in this report/);
  });

  it("replaces the default sort in the spec", () => {
    const s = buildReportSpec("network", { dateRange: sept, dimensions: ["country"], metrics: ["earnings", "impressions"], sort: "impressions:asc" });
    expect(s.sortConditions).toEqual([{ metric: "IMPRESSIONS", order: "ASCENDING" }]);
  });
});

describe("report compare", () => {
  it("adds the previous equal-length period and the change to each row and to the totals", async () => {
    const { svc, calls } = service();
    const r = await svc.networkReport({ from: "2026-09", to: "2026-09", by: ["country"], metrics: ["earnings", "impressions"], compare: "previous" });
    const reports = calls.filter((c) => c.url.includes("networkReport"));
    expect(reports).toHaveLength(2);
    expect(spec(reports[1]!).dateRange).toMatchObject({ startDate: { month: 8, day: 2 }, endDate: { month: 8, day: 31 } });
    expect(r.previous).toMatchObject({ from: "2026-08-02", to: "2026-08-31", totals: { earnings: 109, impressions: 16900 } });
    expect(r.rows[0]).toMatchObject({ country: "NO", earnings: 60, previous_earnings: 40, previous_earnings_micros: 40e6, earnings_change: 0.5, previous_impressions: 10000, impressions_change: 0.2 });
    expect(r.rows[1]).toMatchObject({ country: "SE", earnings_change: -0.5, impressions_change: 0 });
    // New this period: nothing to compare with.
    expect(r.rows[2]).toEqual({ country: "DK", earnings: 5, earnings_micros: 5e6, impressions: 1000 });
    expect(r.totals).toMatchObject({ earnings: 95, earnings_change: (95 - 109) / 109 });
    expect(r.notices.join(" ")).toMatch(/1 row .*only in the previous period/);
  });

  it("computes the change in total RPM from micros, not from rounded amounts", async () => {
    const { svc } = service();
    const r = await svc.networkReport({ from: "2026-09", by: ["country"], metrics: ["earnings", "impressions", "rpm"], compare: "previous" });
    // Previous RPM: 109 / 16 900 × 1000 = 6.4497…, shown as 6.45.
    const before = Math.round((109e6 / 16900) * 1000);
    expect(r.totals).toMatchObject({ rpm: 5, rpm_micros: 5_000_000, rpm_change: (5_000_000 - before) / before });
  });

  it("does not cap the previous period when the current one is capped", async () => {
    const { svc, calls } = service();
    await svc.networkReport({ from: "2026-09", by: ["country"], metrics: ["earnings"], compare: "previous", maxRows: 2 });
    const [cur, prev] = calls.filter((c) => c.url.includes("networkReport"));
    expect(spec(cur!).maxReportRows).toBe(3);
    expect(spec(prev!).maxReportRows).toBeUndefined();
  });

  it("refuses a time series, where rows of two periods never line up", async () => {
    const { svc } = service();
    await expect(svc.networkReport({ from: "2026-09", by: ["date"], compare: "previous" })).rejects.toThrow(/date, week or month/);
  });
});

describe("cli report --sort / --compare", () => {
  async function cli(args: string[], isTTY = false) {
    const f = routes();
    let stdout = "";
    let stderr = "";
    const code = await run(["node", "admobctl", ...args], {
      stdout: (s) => (stdout += s),
      stderr: (s) => (stderr += s),
      isTTY,
      service: { configDir: mkdtempSync(join(tmpdir(), "admobctl-cmpcli-")), tokenProvider: token, fetch: f.fetch, sleep: noSleep, now: NOW },
    });
    return { code, stdout, stderr, calls: f.calls };
  }

  it("sends --sort to the API", async () => {
    const r = await cli(["report", "network", "--from", "2026-09", "--by", "country", "--sort", "impressions:asc"]);
    expect(r.code, r.stderr).toBe(0);
    expect(spec(r.calls.find((c) => c.url.includes("networkReport"))!).sortConditions).toEqual([{ metric: "IMPRESSIONS", order: "ASCENDING" }]);
  });

  it("shows the change of the first metric in the table", async () => {
    const r = await cli(["report", "network", "--from", "2026-09", "--by", "country", "--metrics", "earnings,impressions", "--compare", "previous"], true);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Δ Earnings/);
    expect(r.stdout).toMatch(/NO\s+60\.00\s+\+50\.0%/);
    expect(r.stdout).toMatch(/DK\s+5\.00\s+new/);
    expect(r.stdout).toMatch(/Compared with 2026-08-02 → 2026-08-31/);
  });

  it("rejects an unknown comparison as a usage error", async () => {
    const r = await cli(["report", "network", "--from", "2026-09", "--compare", "last-year"]);
    expect(r.code).toBe(2);
  });
});
