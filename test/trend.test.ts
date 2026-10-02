import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli/program.js";
import type { TokenProvider } from "../src/core/auth/types.js";
import { AdmobService } from "../src/core/service.js";
import { analyzeTrend, levelShift } from "../src/core/trend.js";
import { fakeFetch, fixture, jsonResponse, noSleep, synthReport, type RecordedCall } from "./helpers.js";

const token: TokenProvider = { mode: "adc", getToken: async () => "t", quotaProject: () => "qp" };
const IOS = "ca-app-pub-0000000000000001~1111111111";
const ANDROID = "ca-app-pub-0000000000000001~2222222222";

type Row = Parameters<typeof synthReport>[0][number];
/** `earnings[i]` is day i of the range that starts on 2026-09-18 (a Friday); null = no row that day. */
function days(earnings: Array<number | null>, dims: Record<string, [string, string?]> = {}): Row[] {
  return earnings.flatMap((e, i): Row[] => {
    if (e === null) return [];
    const d = new Date(Date.UTC(2026, 8, 18 + i));
    const date = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
    return [[{ DATE: [date], ...dims }, { ESTIMATED_EARNINGS: e * 1e6, AD_REQUESTS: 1000, MATCHED_REQUESTS: 800, IMPRESSIONS: 400 }]];
  });
}

function setup(rows: Row[]) {
  const f = fakeFetch({
    "GET /v1/accounts?": () => jsonResponse(fixture("accounts.json")),
    "GET /apps": (c) => jsonResponse(fixture(c.url.includes("pageToken=page2") ? "apps-page2.json" : "apps-page1.json")),
    "POST /networkReport:generate": () => jsonResponse(synthReport(rows)),
  });
  const deps = { configDir: mkdtempSync(join(tmpdir(), "admobctl-trend-")), tokenProvider: token, fetch: f.fetch, sleep: noSleep, now: () => new Date("2026-10-02T08:00:00Z") };
  return { svc: AdmobService.create({}, deps), deps, calls: f.calls };
}
const spec = (c: RecordedCall) => (c.body as { reportSpec: { dimensions: string[]; dimensionFilters?: unknown } }).reportSpec;

describe("levelShift", () => {
  it("finds the day a series moves to a new level", () => {
    expect(levelShift([10, 11, 9, 10, 10, 11, 9, 5, 5, 6, 4, 5, 5, 5])).toMatchObject({ index: 7, before: 10, after: 5 });
    expect(levelShift([5, 5, 5, 5, 10, 10, 10, 10])).toMatchObject({ index: 4, before: 5, after: 10 });
  });

  it("ignores noise, flat series and short series", () => {
    expect(levelShift([10, 12, 9, 11, 10, 12, 9, 11, 10, 12])).toBeUndefined();
    expect(levelShift([7, 7, 7, 7, 7, 7, 7, 7])).toBeUndefined();
    expect(levelShift([10, 10, 5, 5])).toBeUndefined();
  });
});

describe("analyzeTrend", () => {
  it("returns the daily series, its weekday pattern and a level shift", async () => {
    const { svc, calls } = setup(days([10, 10, 10, 10, 10, 10, 10, 5, 5, 5, 5, 5, 5, 5]));
    const r = await analyzeTrend(svc, { last: 14 });
    expect(spec(calls.find((c) => c.url.includes("networkReport"))!).dimensions).toEqual(["DATE"]);
    expect(r).toMatchObject({ from: "2026-09-18", to: "2026-10-01", by: "total", currency: "NOK", estimate: true });
    expect(r.rows).toHaveLength(1);
    const s = r.rows[0]!;
    expect(s).toMatchObject({ label: "All apps", earnings: 105, active_days: 14, first_active: "2026-09-18", average_per_day: 7.5 });
    expect(s.shift).toMatchObject({ date: "2026-09-25", before_per_day: 10, after_per_day: 5, change: -0.5 });
    expect(s.days).toHaveLength(14);
    expect(s.days![0]).toMatchObject({ date: "2026-09-18", weekday: "Fri", earnings: 10, requests: 1000, match_rate: 0.8, show_rate: 0.5, ecpm: 25 });
    expect(s.weekdays.map((w) => w.weekday)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(s.weekdays.find((w) => w.weekday === "Fri")).toMatchObject({ days: 2, average: 7.5 });
    expect(r.highlights.map((h) => h.kind)).toEqual(["shift-down"]);
    expect(r.highlights[0]!.message).toMatch(/fell from 10\.00 to 5\.00 NOK per day around 2026-09-25 \(-50\.0%\)/);
  });

  it("counts days without a row as zero once the series has started, and reports a late start", async () => {
    // Nothing for five days (not live yet), then earning, with one silent day in between.
    const { svc } = setup(days([null, null, null, null, null, 8, 8, null, 8, 8, 8, 8, 8, 8]));
    const s = (await analyzeTrend(svc, { last: 14 })).rows[0]!;
    expect(s).toMatchObject({ first_active: "2026-09-23", active_days: 9, average_per_day: 7.11 });
    expect(s.days!.find((d) => d.date === "2026-09-25")).toMatchObject({ earnings: 0, requests: 0 });
    expect(s.days![0]!.date).toBe("2026-09-23");
  });

  it("flags a weekday pattern", async () => {
    // Fri Sat Sun Mon Tue Wed Thu, twice: weekends earn double.
    const week = [10, 20, 20, 10, 10, 10, 10];
    const r = await analyzeTrend(setup(days([...week, ...week])).svc, { last: 14 });
    expect(r.rows[0]!.shift).toBeUndefined();
    const h = r.highlights.find((x) => x.kind === "weekday")!;
    expect(h.message).toMatch(/Sat.*20\.00.*lowest.*10\.00/);
  });

  it("splits into one series per app, format, country or platform", async () => {
    const flat = Array.from({ length: 14 }, () => 4);
    const rows = [...days(flat, { APP: [ANDROID, "Example Quiz"] }), ...days([10, 10, 10, 10, 10, 10, 10, 5, 5, 5, 5, 5, 5, 5], { APP: [IOS, "Example Quiz"] })];
    const { svc, calls } = setup(rows);
    const r = await analyzeTrend(svc, { last: 14, by: "app", app: "example-quiz-ios" });
    const s = spec(calls.find((c) => c.url.includes("networkReport"))!);
    expect(s.dimensions).toEqual(["DATE", "APP"]);
    expect(s.dimensionFilters).toEqual([{ dimension: "APP", matchesAny: { values: [IOS] } }]);
    expect(r.rows.map((x) => x.label)).toEqual(["example-quiz-ios", "example-quiz-android"]);
    expect(r.rows[0]!.shift).toMatchObject({ date: "2026-09-25", change: -0.5 });
    expect(r.rows[1]!.shift).toBeUndefined();
    expect(r.highlights[0]!.message).toMatch(/^example-quiz-ios fell/);
  });

  it("keeps the ten biggest series and can leave the days out", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => days([i + 1, i + 1, i + 1], { COUNTRY: [`C${i}`] })).flat();
    const r = await analyzeTrend(setup(rows).svc, { last: 14, by: "country", days: false });
    expect(r.rows).toHaveLength(10);
    expect(r.rows[0]!.label).toBe("C11");
    expect(r.rows[0]!.days).toBeUndefined();
    expect(r.notices.join(" ")).toMatch(/10 of 12/);
  });

  it("rejects an unknown split", async () => {
    await expect(analyzeTrend(setup([]).svc, { by: "colour" as never })).rejects.toThrow(/--by must be one of/);
  });
});

describe("cli analyze trend", () => {
  it("prints the daily table for one series", async () => {
    const { deps } = setup(days([10, 10, 10, 10, 10, 10, 10, 5, 5, 5, 5, 5, 5, 5]));
    let stdout = "";
    const code = await run(["node", "admobctl", "analyze", "trend", "--last", "14d"], { stdout: (s) => (stdout += s), stderr: () => {}, isTTY: true, service: deps });
    expect(code).toBe(0);
    expect(stdout).toMatch(/2026-09-18\s+Fri\s+10\.00/);
    expect(stdout).toMatch(/fell from 10\.00 to 5\.00/);
  });
});
