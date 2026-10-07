import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli/program.js";
import type { TokenProvider } from "../src/core/auth/types.js";
import { check } from "../src/core/check.js";
import { saveConfig, setProfileValue } from "../src/core/config.js";
import { AdmobService } from "../src/core/service.js";
import { fakeFetch, fixture, jsonResponse, noSleep, synthReport, type RecordedCall } from "./helpers.js";

const token: TokenProvider = { mode: "adc", getToken: async () => "t", quotaProject: () => "qp" };
const IOS = "ca-app-pub-0000000000000001~1111111111";
const ANDROID = "ca-app-pub-0000000000000001~2222222222";
const TIMER = "ca-app-pub-0000000000000001~3333333333";

type M = [earnings: number, requests: number, matched: number, impressions: number];
const row = (app: string, [e, r, m, i]: M) =>
  [{ APP: [app, "x"] }, { ESTIMATED_EARNINGS: e, AD_REQUESTS: r, MATCHED_REQUESTS: m, IMPRESSIONS: i }] as [Record<string, [string, string]>, Record<string, number>];

type Rows = Array<ReturnType<typeof row>>;
type ApiDate = { year: number; month: number; day: number };
type Spec = { dateRange: { startDate: ApiDate; endDate: ApiDate }; dimensions: string[] };
const specOf = (c: RecordedCall) => (c.body as { reportSpec: Spec }).reportSpec;

/** Every date of a range as the API writes it (YYYYMMDD). */
function datesIn({ startDate: s, endDate: e }: Spec["dateRange"]): string[] {
  const out: string[] = [];
  for (let d = Date.UTC(s.year, s.month - 1, s.day); d <= Date.UTC(e.year, e.month - 1, e.day); d += 86_400_000) {
    out.push(new Date(d).toISOString().slice(0, 10).replace(/-/g, ""));
  }
  return out;
}
const weekday = (date: string) => new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T00:00:00Z`).getUTCDay();

/** Rows summed per app, as a report without the date dimension has them. */
function sumByApp(rows: Rows): Rows {
  const out = new Map<string, ReturnType<typeof row>>();
  for (const [dims, metrics] of rows) {
    const sum = out.get(dims.APP![0]) ?? [dims, {}];
    for (const [k, v] of Object.entries(metrics)) sum[1][k] = (sum[1][k] ?? 0) + v;
    out.set(dims.APP![0], sum);
  }
  return [...out.values()];
}

/**
 * The window ends Oct 1, a Thursday (one day unless --window says otherwise). `baseline` gives the rows of each day
 * before it: the same every day, or per date (YYYYMMDD). A report by date gets them per date; one by app, summed.
 */
function setup(window: Rows, baseline: Rows | ((date: string) => Rows), profile: Record<string, unknown> = {}, now = "2026-10-02T08:00:00Z") {
  const day = typeof baseline === "function" ? baseline : () => baseline;
  const dir = mkdtempSync(join(tmpdir(), "admobctl-check-"));
  saveConfig(dir, { profiles: { default: profile } });
  const f = fakeFetch({
    "GET /v1/accounts?": () => jsonResponse(fixture("accounts.json")),
    "GET /apps": (c) => jsonResponse(fixture(c.url.includes("pageToken=page2") ? "apps-page2.json" : "apps-page1.json")),
    "POST /networkReport:generate": (c) => {
      const { dateRange, dimensions } = specOf(c);
      if (dateRange.endDate.month === 10) return jsonResponse(synthReport(window));
      const days = datesIn(dateRange);
      if (!dimensions.includes("DATE")) return jsonResponse(synthReport(sumByApp(days.flatMap(day))));
      return jsonResponse(synthReport(days.flatMap((d) => day(d).map(([dims, m]): ReturnType<typeof row> => [{ ...dims, DATE: [d, d] }, m]))));
    },
  });
  const deps = { configDir: dir, tokenProvider: token, fetch: f.fetch, sleep: noSleep, now: () => new Date(now) };
  return { svc: AdmobService.create({}, deps), deps, calls: f.calls };
}

// One baseline day: iOS earns 10 from 2k requests, 75% match, 80% show.
const baseline = [row(IOS, [10e6, 2000, 1500, 1200]), row(ANDROID, [5e6, 1000, 500, 400]), row(TIMER, [0.1e6, 20, 15, 12])];

describe("check", () => {
  it("passes when the window is in line with the baseline: by default the same weekday in the four weeks before", async () => {
    const { svc, calls } = setup([row(IOS, [9e6, 2000, 1500, 1200]), row(ANDROID, [5e6, 1000, 500, 400])], baseline);
    const r = await check(svc);
    const specs = calls.filter((c) => c.url.includes("networkReport")).map(specOf);
    expect(specs[0]).toMatchObject({ dateRange: { startDate: { month: 10, day: 1 }, endDate: { month: 10, day: 1 } }, dimensions: ["APP"] });
    expect(specs[1]).toMatchObject({ dateRange: { startDate: { month: 9, day: 3 }, endDate: { month: 9, day: 24 } }, dimensions: ["APP", "DATE"] });
    expect(r.breaches).toBe(0);
    expect(r.findings).toEqual([]);
    expect(r).toMatchObject({
      window: { from: "2026-10-01", to: "2026-10-01", days: 1 },
      baseline: { from: "2026-09-03", to: "2026-09-24", days: 4, weeks: 4 },
      thresholds: { drop: 0.3, min_requests: 1000 },
    });
    const ios = r.rows.find((x) => x.app === "example-quiz-ios")!;
    expect(ios).toMatchObject({ status: "ok", earnings_per_day: 9, baseline_earnings_per_day: 10, earnings_change: -0.1, baseline_requests: 8000 });
    expect(r.total).toMatchObject({ status: "ok", earnings_per_day: 14 });
    expect(r.summary[0]).toBe("No drop of 30.0% or more in earnings, match rate or show rate, 2026-10-01 against the 4 Thursdays before (2026-09-03 → 2026-09-24).");
  });

  it("does not call a weekly low a drop, as the seven days before would", async () => {
    // Thursdays, like the window (Oct 1), earn 5; the other days 12.
    const weekly = (date: string) => [row(IOS, [weekday(date) === 4 ? 5e6 : 12e6, 2000, 1500, 1200])];
    const window = [row(IOS, [5e6, 2000, 1500, 1200])];
    const sameWeekday = await check(setup(window, weekly).svc, { app: "example-quiz-ios" });
    expect(sameWeekday.breaches).toBe(0);
    expect(sameWeekday.rows[0]).toMatchObject({ baseline_earnings_per_day: 5, earnings_change: 0 });
    const daysBefore = await check(setup(window, weekly).svc, { app: "example-quiz-ios", baseline: 7 });
    expect(daysBefore.baseline).toEqual({ from: "2026-09-24", to: "2026-09-30", days: 7 });
    expect(daysBefore.findings.map((f) => f.metric)).toEqual(["earnings"]);
    expect(daysBefore.summary[0]).toContain("2026-10-01 against 2026-09-24 → 2026-09-30");
  });

  it("compares a window of several days with the same weekdays in the weeks before", async () => {
    // The window is Tue Sep 29 → Thu Oct 1; other weekdays would wreck the baseline if they were counted.
    const tueToThu = (date: string) => ([2, 3, 4].includes(weekday(date)) ? [baseline[0]!] : [row(IOS, [99e6, 99999, 0, 0])]);
    const r = await check(setup([row(IOS, [30e6, 6000, 4500, 3600])], tueToThu).svc, { app: "example-quiz-ios", window: 3, baselineWeeks: 2 });
    expect(r.baseline).toEqual({ from: "2026-09-15", to: "2026-09-24", days: 6, weeks: 2 });
    expect(r.rows[0]).toMatchObject({ status: "ok", earnings_per_day: 10, baseline_earnings_per_day: 10, baseline_requests: 12000 });
    expect(r.summary[0]).toContain("2026-09-29 → 2026-10-01 against the same weekdays in the 2 weeks before (2026-09-15 → 2026-09-24)");
  });

  it("keeps the seven days before for windows over a week, where weekdays cannot be matched", async () => {
    const { svc } = setup([row(IOS, [80e6, 16000, 12000, 9600])], baseline);
    expect((await check(svc, { app: "example-quiz-ios", window: 8 })).baseline).toEqual({ from: "2026-09-17", to: "2026-09-23", days: 7 });
    await expect(check(svc, { window: 8, baselineWeeks: 4 })).rejects.toThrow(/window of 7 days or fewer/);
  });

  it("notes that yesterday may be incomplete before 04:00 in the account's time zone", async () => {
    const window = [row(IOS, [9e6, 2000, 1500, 1200]), row(ANDROID, [5e6, 1000, 500, 400])];
    // 01:30 UTC is 03:30 in Oslo (CEST).
    const early = await check(setup(window, baseline, {}, "2026-10-02T01:30:00Z").svc);
    expect(early.notices[0]).toMatch(/^It is 03:30 in Europe\/Oslo: .*yesterday.*incomplete.*after about 04:00/);
    expect((await check(setup(window, baseline, {}, "2026-10-02T02:00:00Z").svc)).notices.join(" ")).not.toMatch(/04:00/);
  });

  it("flags earnings, match rate and show rate drops per app and in total", async () => {
    const { svc } = setup(
      [
        row(IOS, [5e6, 2000, 1500, 1200]), // earnings halved, rates unchanged
        row(ANDROID, [5e6, 1000, 250, 100]), // match rate 50% → 25%, show rate 80% → 40%
      ],
      baseline,
    );
    const r = await check(svc);
    expect(r.findings.map((f) => `${f.app}:${f.metric}`)).toEqual([
      "example-quiz-ios:earnings",
      "example-quiz-android:match_rate",
      "example-quiz-android:show_rate",
      "(all apps):earnings",
    ]);
    expect(r.breaches).toBe(4);
    expect(r.findings[0]!.message).toMatch(/example-quiz-ios earned 5\.00 NOK per day, 50\.0% below its 10\.00 NOK baseline/);
    expect(r.findings[1]!.message).toMatch(/match rate fell to 25\.0% from 50\.0%/);
    expect(r.rows.find((x) => x.app === "example-quiz-android")!.status).toBe("breach");
  });

  it("flags an app that stopped earning altogether", async () => {
    const { svc } = setup([row(ANDROID, [5e6, 1000, 500, 400])], baseline);
    const r = await check(svc);
    const ios = r.rows.find((x) => x.app === "example-quiz-ios")!;
    expect(ios).toMatchObject({ status: "breach", earnings_per_day: 0, earnings_change: -1, requests: 0 });
    expect(r.findings[0]!.message).toMatch(/sent no ad requests/);
  });

  it("flags an app that stopped sending requests even when its baseline earned nothing", async () => {
    const unfilled = [row(IOS, [0, 2000, 0, 0]), row(ANDROID, [5e6, 1000, 500, 400])];
    const { svc } = setup([row(ANDROID, [5e6, 1000, 500, 400])], unfilled);
    const r = await check(svc);
    const ios = r.rows.find((x) => x.app === "example-quiz-ios")!;
    expect(ios).toMatchObject({ status: "breach", requests: 0, baseline_requests: 8000 });
    expect(r.findings[0]).toMatchObject({ app: "example-quiz-ios", metric: "requests", change: -1 });
    expect(r.findings[0]!.message).toMatch(/sent no ad requests/);
  });

  it("does not judge apps with too little baseline traffic", async () => {
    const { svc } = setup([row(IOS, [9e6, 2000, 1500, 1200]), row(ANDROID, [5e6, 1000, 500, 400]), row(TIMER, [0, 5, 0, 0])], baseline);
    const r = await check(svc);
    expect(r.rows.find((x) => x.app === "sample-timer-focus-breaks-ios")!.status).toBe("thin");
    expect(r.breaches).toBe(0);
    expect(r.notices.join(" ")).toMatch(/1 app .*fewer than 1000 requests/);
  });

  it("takes thresholds from options, then config, then defaults", async () => {
    const window = [row(IOS, [8e6, 2000, 1500, 1200]), row(ANDROID, [5e6, 1000, 500, 400])]; // iOS −20%
    expect((await check(setup(window, baseline).svc)).breaches).toBe(0);
    expect((await check(setup(window, baseline).svc, { drop: 0.15 })).findings.map((f) => f.app)).toEqual(["example-quiz-ios"]);
    const configured = setup(window, baseline, { check: { drop: "15", baseline: "14" } });
    const r = await check(configured.svc);
    expect(r.thresholds.drop).toBe(0.15);
    expect(r.baseline).toEqual({ from: "2026-09-17", to: "2026-09-30", days: 14 });
    expect((await check(configured.svc, { drop: 0.5 })).thresholds.drop).toBe(0.5);
    expect((await check(configured.svc, { baselineWeeks: 2 })).baseline).toEqual({ from: "2026-09-17", to: "2026-09-24", days: 2, weeks: 2 });
  });

  it("reads a configured baseline in days (7, 7d) or weeks (2w)", async () => {
    const window = [row(IOS, [9e6, 2000, 1500, 1200])];
    expect((await check(setup(window, baseline, { check: { baseline: "7d" } }).svc)).baseline).toEqual({ from: "2026-09-24", to: "2026-09-30", days: 7 });
    expect((await check(setup(window, baseline, { check: { baseline: "2w" } }).svc)).baseline).toMatchObject({ days: 2, weeks: 2 });
    expect((await check(setup(window, baseline, { check: { baseline: "2w" } }).svc, { baseline: 7 })).baseline).toMatchObject({ days: 7 });
    await expect(check(setup(window, baseline, { check: { baseline: "2x" } }).svc)).rejects.toThrow(/check.baseline/);
  });

  it("limits the check to one app", async () => {
    const { svc, calls } = setup([row(IOS, [9e6, 2000, 1500, 1200])], [baseline[0]!]);
    const r = await check(svc, { app: "example-quiz-ios" });
    const sent = calls.find((c) => c.url.includes("networkReport"))!.body as { reportSpec: { dimensionFilters: unknown } };
    expect(sent.reportSpec.dimensionFilters).toEqual([{ dimension: "APP", matchesAny: { values: [IOS] } }]);
    expect(r.total).toBeUndefined();
  });

  it("rejects thresholds that make no sense", async () => {
    const { svc } = setup([], []);
    await expect(check(svc, { drop: 1.5 })).rejects.toThrow(/between 1 and 99/);
    await expect(check(svc, { window: 0 })).rejects.toThrow(/window/);
    await expect(check(svc, { baselineWeeks: 53 })).rejects.toThrow(/between 1 and 52/);
    await expect(check(svc, { baseline: 7, baselineWeeks: 4 })).rejects.toThrow(/days or in weeks, not both/);
  });
});

describe("config check.*", () => {
  it("stores whole numbers and rejects anything else", () => {
    const cfg = { profiles: {} };
    setProfileValue(cfg, "default", "check.drop", "40");
    expect(cfg).toEqual({ profiles: { default: { check: { drop: "40" } } } });
    expect(() => setProfileValue(cfg, "default", "check.drop", "lots")).toThrow(/whole number/);
    expect(() => setProfileValue(cfg, "default", "check.nope", "1")).toThrow(/Unknown config key/);
    for (const v of ["7", "7d", "4w"]) setProfileValue(cfg, "default", "check.baseline", v);
    expect(cfg).toMatchObject({ profiles: { default: { check: { baseline: "4w" } } } });
    expect(() => setProfileValue(cfg, "default", "check.baseline", "4x")).toThrow(/days like 7d or weeks like 4w/);
    expect(() => setProfileValue(cfg, "default", "check.baseline", "0w")).toThrow(/days like 7d or weeks like 4w/);
  });
});

describe("cli check", () => {
  async function cli(args: string[], window: Array<ReturnType<typeof row>>, isTTY = true) {
    const { deps } = setup(window, baseline);
    let stdout = "";
    let stderr = "";
    const code = await run(["node", "admobctl", ...args], { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s), isTTY, service: deps });
    return { code, stdout, stderr };
  }

  it("exits 0 when nothing dropped and 1 on a breach", async () => {
    const fine = await cli(["check"], [row(IOS, [9e6, 2000, 1500, 1200]), row(ANDROID, [5e6, 1000, 500, 400])]);
    expect(fine.code, fine.stderr).toBe(0);
    expect(fine.stdout).toMatch(/example-quiz-ios\s+ok/);
    const bad = await cli(["check", "--drop", "30", "--window", "1d", "--baseline", "7d"], [row(IOS, [5e6, 2000, 1500, 1200]), row(ANDROID, [5e6, 1000, 500, 400])]);
    expect(bad.code).toBe(1);
    expect(bad.stdout).toMatch(/example-quiz-ios\s+DROP/);
    expect(bad.stdout).toMatch(/50\.0% below/);
  });

  it("takes --baseline in days or weeks", async () => {
    const window = [row(IOS, [9e6, 2000, 1500, 1200]), row(ANDROID, [5e6, 1000, 500, 400])];
    const weeks = await cli(["check", "--baseline", "2w"], window, false);
    expect(weeks.code, weeks.stderr).toBe(0);
    expect(JSON.parse(weeks.stdout).baseline).toEqual({ from: "2026-09-17", to: "2026-09-24", days: 2, weeks: 2 });
    const days = await cli(["check", "--baseline", "7d"], window, false);
    expect(JSON.parse(days.stdout).baseline).toEqual({ from: "2026-09-24", to: "2026-09-30", days: 7 });
    const bad = await cli(["check", "--baseline", "2x"], window, false);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toMatch(/--baseline expects days like 7d or weeks like 4w/);
  });
});
