import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli/program.js";
import type { TokenProvider } from "../src/core/auth/types.js";
import { financeForecast } from "../src/core/finance.js";
import { AdmobService } from "../src/core/service.js";
import { fakeFetch, fixture, jsonResponse, noSleep, synthReport, type RecordedCall } from "./helpers.js";

const token: TokenProvider = { mode: "adc", getToken: async () => "t", quotaProject: () => "qp" };
const IOS = "ca-app-pub-0000000000000001~1111111111";
const ANDROID = "ca-app-pub-0000000000000001~2222222222";

function setup(now: string) {
  const f = fakeFetch({
    "GET /v1/accounts?": () => jsonResponse(fixture("accounts.json")),
    "GET /apps": (c) => jsonResponse(fixture(c.url.includes("pageToken=page2") ? "apps-page2.json" : "apps-page1.json")),
    "POST /networkReport:generate": () =>
      jsonResponse(synthReport([[{ APP: [IOS, "Example Quiz"] }, { ESTIMATED_EARNINGS: 20_000_000 }], [{ APP: [ANDROID, "Example Quiz"] }, { ESTIMATED_EARNINGS: 10_335_000 }]])),
  });
  const deps = { configDir: mkdtempSync(join(tmpdir(), "admobctl-fc-")), tokenProvider: token, fetch: f.fetch, sleep: noSleep, now: () => new Date(now) };
  return { svc: AdmobService.create({}, deps), deps, calls: f.calls };
}
const sentRange = (calls: RecordedCall[]) =>
  (calls.find((c) => c.url.includes("networkReport"))!.body as { reportSpec: { dateRange: { startDate: { day: number }; endDate: { month: number; day: number } } } }).reportSpec.dateRange;

describe("financeForecast", () => {
  it("projects the current month from its complete days", async () => {
    const { svc, calls } = setup("2026-09-11T08:00:00Z");
    const r = await financeForecast(svc);
    // Today (the 11th) is still partial, so only the 1st to the 10th count.
    expect(sentRange(calls)).toMatchObject({ startDate: { day: 1 }, endDate: { month: 9, day: 10 } });
    expect(r).toMatchObject({
      month: "2026-09",
      complete: false,
      estimate: true,
      projection: true,
      days_elapsed: 10,
      days_in_month: 30,
      days_remaining: 20,
      month_to_date: 30.34,
      month_to_date_micros: 30_335_000,
      daily_average: 3.03,
      projected: 91.01,
      projected_micros: 91_005_000,
    });
    expect(r.apps).toEqual([
      expect.objectContaining({ alias: "example-quiz-ios", month_to_date: 20, projected: 60, projected_micros: 60_000_000 }),
      expect.objectContaining({ alias: "example-quiz-android", month_to_date: 10.34, projected: 31.01, projected_micros: 31_005_000 }),
    ]);
    // Per-app amounts add up to the totals.
    expect(r.apps.reduce((a, x) => a + Math.round(x.projected * 100), 0)).toBe(9101);
    expect(r.notes.join(" ")).toMatch(/projection/i);
    expect(r.notes.join(" ")).toMatch(/finalized/);
  });

  it("warns when the projection rests on less than a week", async () => {
    const { svc } = setup("2026-09-04T08:00:00Z");
    expect((await financeForecast(svc)).notes.join(" ")).toMatch(/Only 3 days/);
    const later = setup("2026-09-11T08:00:00Z");
    expect((await financeForecast(later.svc)).notes.join(" ")).not.toMatch(/Only/);
  });

  it("returns the actual figure for a month that has ended", async () => {
    const { svc, calls } = setup("2026-10-02T08:00:00Z");
    const r = await financeForecast(svc, "2026-09");
    expect(sentRange(calls).endDate).toMatchObject({ month: 9, day: 30 });
    expect(r).toMatchObject({ complete: true, projection: false, days_remaining: 0, month_to_date: 30.34, projected: 30.34 });
  });

  it("explains when there is nothing to project from yet", async () => {
    const first = setup("2026-10-01T08:00:00Z");
    await expect(financeForecast(first.svc)).rejects.toThrow(/no complete day/i);
    const future = setup("2026-10-02T08:00:00Z");
    await expect(financeForecast(future.svc, "2026-11")).rejects.toThrow(/has not started/);
  });
});

describe("cli finance forecast", () => {
  it("prints month to date and the projection per app", async () => {
    const { deps } = setup("2026-09-11T08:00:00Z");
    let stdout = "";
    const code = await run(["node", "admobctl", "finance", "forecast"], { stdout: (s) => (stdout += s), stderr: () => {}, isTTY: true, service: deps });
    expect(code).toBe(0);
    expect(stdout).toMatch(/example-quiz-ios\s+.*20\.00\s+60\.00/);
    expect(stdout).toMatch(/Total\s+.*30\.34\s+91\.01/);
    expect(stdout).toMatch(/10 of 30 days/);
  });
});
