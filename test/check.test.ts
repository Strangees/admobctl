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

type Range = { startDate: { month: number; day: number }; endDate: { month: number; day: number } };
const rangeOf = (c: RecordedCall) => (c.body as { reportSpec: { dateRange: Range } }).reportSpec.dateRange;

/** The window is one day (Oct 1); the baseline is the seven days before it. */
function setup(window: Array<ReturnType<typeof row>>, baseline: Array<ReturnType<typeof row>>, profile: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "admobctl-check-"));
  saveConfig(dir, { profiles: { default: profile } });
  const f = fakeFetch({
    "GET /v1/accounts?": () => jsonResponse(fixture("accounts.json")),
    "GET /apps": (c) => jsonResponse(fixture(c.url.includes("pageToken=page2") ? "apps-page2.json" : "apps-page1.json")),
    "POST /networkReport:generate": (c) => jsonResponse(synthReport(rangeOf(c).startDate.month === 10 ? window : baseline)),
  });
  const deps = { configDir: dir, tokenProvider: token, fetch: f.fetch, sleep: noSleep, now: () => new Date("2026-10-02T08:00:00Z") };
  return { svc: AdmobService.create({}, deps), deps, calls: f.calls };
}

// Seven baseline days: iOS 70 a week (10 a day), 14k requests, 75% match, 80% show.
const baseline = [row(IOS, [70e6, 14000, 10500, 8400]), row(ANDROID, [35e6, 7000, 3500, 2800]), row(TIMER, [0.7e6, 140, 100, 80])];

describe("check", () => {
  it("passes when the window is in line with the baseline", async () => {
    const { svc, calls } = setup([row(IOS, [9e6, 2000, 1500, 1200]), row(ANDROID, [5e6, 1000, 500, 400])], baseline);
    const r = await check(svc);
    const ranges = calls.filter((c) => c.url.includes("networkReport")).map(rangeOf);
    expect(ranges[0]).toMatchObject({ startDate: { month: 10, day: 1 }, endDate: { month: 10, day: 1 } });
    expect(ranges[1]).toMatchObject({ startDate: { month: 9, day: 24 }, endDate: { month: 9, day: 30 } });
    expect(r.breaches).toBe(0);
    expect(r.findings).toEqual([]);
    expect(r).toMatchObject({ window: { from: "2026-10-01", to: "2026-10-01", days: 1 }, baseline: { from: "2026-09-24", to: "2026-09-30", days: 7 }, thresholds: { drop: 0.3, min_requests: 1000 } });
    const ios = r.rows.find((x) => x.app === "example-quiz-ios")!;
    expect(ios).toMatchObject({ status: "ok", earnings_per_day: 9, baseline_earnings_per_day: 10, earnings_change: -0.1 });
    expect(r.total).toMatchObject({ status: "ok", earnings_per_day: 14 });
    expect(r.summary[0]).toMatch(/No drop/);
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
    const unfilled = [row(IOS, [0, 14000, 0, 0]), row(ANDROID, [35e6, 7000, 3500, 2800])];
    const { svc } = setup([row(ANDROID, [5e6, 1000, 500, 400])], unfilled);
    const r = await check(svc);
    const ios = r.rows.find((x) => x.app === "example-quiz-ios")!;
    expect(ios).toMatchObject({ status: "breach", requests: 0, baseline_requests: 14000 });
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
    expect(r.baseline.days).toBe(14);
    expect((await check(configured.svc, { drop: 0.5 })).thresholds.drop).toBe(0.5);
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
  });
});

describe("config check.*", () => {
  it("stores whole numbers and rejects anything else", () => {
    const cfg = { profiles: {} };
    setProfileValue(cfg, "default", "check.drop", "40");
    expect(cfg).toEqual({ profiles: { default: { check: { drop: "40" } } } });
    expect(() => setProfileValue(cfg, "default", "check.drop", "lots")).toThrow(/whole number/);
    expect(() => setProfileValue(cfg, "default", "check.nope", "1")).toThrow(/Unknown config key/);
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
});
