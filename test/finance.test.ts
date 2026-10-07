import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allocateRounded, financeForecast, financeMonth, financeRange, journalRows } from "../src/core/finance.js";
import { saveConfig } from "../src/core/config.js";
import { AdmobService } from "../src/core/service.js";
import type { TokenProvider } from "../src/core/auth/types.js";
import { fakeFetch, fixture, jsonResponse, noSleep, synthReport } from "./helpers.js";

const token: TokenProvider = { mode: "adc", getToken: async () => "t", quotaProject: () => "qp" };

/** `report` is a fixture name or a report body. */
function service(report: string | unknown[], profile: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "admobctl-fin-"));
  saveConfig(dir, { profiles: { default: profile } });
  const f = fakeFetch({
    "GET /v1/accounts?": () => jsonResponse(fixture("accounts.json")),
    "GET /apps": (c) => jsonResponse(fixture(c.url.includes("pageToken=page2") ? "apps-page2.json" : "apps-page1.json")),
    "POST /networkReport:generate": () => jsonResponse(typeof report === "string" ? fixture(report) : report),
  });
  const svc = AdmobService.create(
    {},
    { configDir: dir, tokenProvider: token, fetch: f.fetch, sleep: noSleep, now: () => new Date("2026-10-02T08:00:00Z") },
  );
  return { svc, calls: f.calls };
}

describe("allocateRounded", () => {
  it("rounds parts so they sum exactly to the rounded total (largest remainder)", () => {
    // Each part is 0.335; naive rounding gives 0.34 × 3 = 1.02, but the total is 1.01.
    expect(allocateRounded([335_000, 335_000, 335_000])).toEqual({ total: 101, parts: [34, 34, 33] });
  });

  it("returns cents and leaves exact parts untouched", () => {
    expect(allocateRounded([60_125_000, 30_004_999, 12_320_001])).toEqual({ total: 10245, parts: [6013, 3000, 1232] });
  });

  it("handles an empty list", () => {
    expect(allocateRounded([])).toEqual({ total: 0, parts: [] });
  });

  it("rounds to the currency's minor unit", () => {
    expect(allocateRounded([1_000_400_000, 234_570_000], 0)).toEqual({ total: 1235, parts: [1000, 235] });
    expect(allocateRounded([1_000_400, 234_570], 3)).toEqual({ total: 1235, parts: [1000, 235] });
  });
});

const IOS = "ca-app-pub-0000000000000001~1111111111";
const ANDROID = "ca-app-pub-0000000000000001~2222222222";
const WARNING = { type: "DATA_DELAYED", description: "Data for 2026-09-30 is delayed." };
/** A report by app whose footer carries an API warning. */
function warnedReport(dims: Record<string, [string]> = {}) {
  const r = synthReport([[{ ...dims, APP: [IOS] }, { ESTIMATED_EARNINGS: 5_000_000 }]]);
  r[r.length - 1] = { footer: { matchingRowCount: "1", warnings: [WARNING] } } as never;
  return r;
}

describe("financeMonth", () => {
  it("returns per-app earnings and a total from exact micros", async () => {
    const { svc, calls } = service("network-report-by-app.json");
    const r = await financeMonth(svc, "2026-09");
    const spec = (calls.find((c) => c.url.includes("networkReport"))!.body as { reportSpec: Record<string, unknown> }).reportSpec;
    expect(spec.dimensions).toEqual(["APP"]);
    expect(spec.metrics).toEqual(["ESTIMATED_EARNINGS"]);
    expect(spec.dateRange).toEqual({ startDate: { year: 2026, month: 9, day: 1 }, endDate: { year: 2026, month: 9, day: 30 } });
    expect(r.month).toBe("2026-09");
    expect(r.currency).toBe("NOK");
    expect(r.complete).toBe(true);
    expect(r.total).toBe(102.45);
    expect(r.totalMicros).toBe(102_450_000);
    expect(r.apps.map((a) => [a.alias, a.earnings])).toEqual([
      ["example-quiz-ios", 60.13],
      ["example-quiz-android", 30.0],
      ["sample-timer-focus-breaks-ios", 12.32],
    ]);
    expect(r.estimate).toBe(true);
    expect(r.notes.join(" ")).toMatch(/estimated.*reconcile against AdMob Payments \(finalized\)/i);
  });

  it("flags the current month as incomplete", async () => {
    const { svc } = service("network-report-by-app.json");
    const r = await financeMonth(svc, "2026-10");
    expect(r.complete).toBe(false);
    expect(r.notes.join(" ")).toMatch(/incomplete/i);
    expect(r.notes.join(" ")).toMatch(/Includes today/);
  });

  it("rounds to the currency's minor unit: whole yen for JPY", async () => {
    const { svc } = service(synthReport([[{ APP: [IOS] }, { ESTIMATED_EARNINGS: 1_000_400_000 }], [{ APP: [ANDROID] }, { ESTIMATED_EARNINGS: 234_570_000 }]], "JPY"));
    const r = await financeMonth(svc, "2026-09");
    expect(r.currency).toBe("JPY");
    expect(r.total).toBe(1235);
    expect(r.apps.map((a) => a.earnings)).toEqual([1000, 235]);
    const rows = journalRows(r, svc.profile.finance);
    expect(rows.map((x) => x.Debet || x.Kredit)).toEqual(["1235", "1000", "235"]);
  });

  it("stops at `through`: the report ends there and so does the month's period", async () => {
    const { svc, calls } = service("network-report-by-app.json");
    const r = await financeMonth(svc, "2026-10", { through: { year: 2026, month: 10, day: 1 } });
    const spec = (calls.find((c) => c.url.includes("networkReport"))!.body as { reportSpec: Record<string, unknown> }).reportSpec;
    expect(spec.dateRange).toEqual({ startDate: { year: 2026, month: 10, day: 1 }, endDate: { year: 2026, month: 10, day: 1 } });
    expect(r).toMatchObject({ from: "2026-10-01", to: "2026-10-01", bookingDate: "2026-10-01", complete: false });
  });

  it("passes the API's warnings on in the notes", async () => {
    const { svc } = service(warnedReport());
    expect((await financeMonth(svc, "2026-09")).notes).toContain("API warning: Data for 2026-09-30 is delayed.");
  });
});

describe("journalRows", () => {
  it("debits the receivable and credits revenue per app, dated at month-end", async () => {
    const { svc } = service("network-report-by-app.json");
    const rows = journalRows(await financeMonth(svc, "2026-09"), svc.profile.finance);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ Dato: "2026-09-30", Konto: "1509", Debet: "102.45", Kredit: "" });
    expect(rows.slice(1).map((r) => [r.Konto, r.Kredit])).toEqual([
      ["3120", "60.13"],
      ["3120", "30.00"],
      ["3120", "12.32"],
    ]);
    expect(Object.keys(rows[0]!)).toEqual([
      "Bilag", "Dato", "Kilde", "Beskrivelse", "Konto", "Kontonavn", "Debet", "Kredit",
      "MVA-behandling", "Motpart", "Status", "Merknad",
    ]);
    expect(rows[1]!.Beskrivelse).toContain("example-quiz-ios");
    expect(rows[0]!.Merknad).toMatch(/finalized/i);
  });

  it("keeps an app that lost money as a negative credit, so debit and credits still balance", async () => {
    const { svc } = service(synthReport([[{ APP: [IOS] }, { ESTIMATED_EARNINGS: 10_000_000 }], [{ APP: [ANDROID] }, { ESTIMATED_EARNINGS: -500_000 }]]));
    const rows = journalRows(await financeMonth(svc, "2026-09"), svc.profile.finance);
    expect(rows.map((r) => [r.Debet, r.Kredit])).toEqual([["9.50", ""], ["", "10.00"], ["", "-0.50"]]);
  });

  it("uses configured accounts and decimal comma", async () => {
    const { svc } = service("network-report-by-app.json", {
      finance: { receivableAccount: "1500", revenueAccount: "3100", decimalSeparator: "," },
    });
    const rows = journalRows(await financeMonth(svc, "2026-09"), svc.profile.finance);
    expect(rows[0]).toMatchObject({ Konto: "1500", Debet: "102,45" });
    expect(rows[1]).toMatchObject({ Konto: "3100", Kredit: "60,13" });
  });
});

describe("financeRange", () => {
  it("returns month totals and a grand total from exact micros", async () => {
    const { svc, calls } = service("network-report-by-month-app.json");
    const r = await financeRange(svc, "2026-07", "2026-09");
    const spec = (calls.find((c) => c.url.includes("networkReport"))!.body as { reportSpec: Record<string, unknown> }).reportSpec;
    expect(spec.dimensions).toEqual(["MONTH", "APP"]);
    expect(r.months.map((m) => [m.month, m.total])).toEqual([
      ["2026-07", 65.0],
      ["2026-08", 78.08],
      ["2026-09", 102.45],
    ]);
    expect(r.total).toBe(245.53);
    expect(r.months[2]!.apps[0]).toMatchObject({ alias: "example-quiz-ios", earnings: 60.13 });
  });

  it("totals a range as the sum of its rounded month totals, so it matches what was booked", async () => {
    // Exact: 1.004 + 1.004 = 2.008 → 2.01, but the booked months are 1.00 + 1.00 = 2.00.
    const row = (month: string, micros: number) => ({
      row: {
        dimensionValues: { MONTH: { value: month }, APP: { value: "ca-app-pub-0000000000000001~1111111111" } },
        metricValues: { ESTIMATED_EARNINGS: { microsValue: String(micros) } },
      },
    });
    const dir = mkdtempSync(join(tmpdir(), "admobctl-fin-"));
    const f = fakeFetch({
      "GET /v1/accounts?": () => jsonResponse(fixture("accounts.json")),
      "GET /apps": (c) => jsonResponse(fixture(c.url.includes("pageToken=page2") ? "apps-page2.json" : "apps-page1.json")),
      "POST /networkReport:generate": () =>
        jsonResponse([
          { header: { localizationSettings: { currencyCode: "NOK" }, reportingTimeZone: "Europe/Oslo" } },
          row("202608", 1_004_000),
          row("202609", 1_004_000),
          { footer: { matchingRowCount: "2" } },
        ]),
    });
    const svc = AdmobService.create({}, { configDir: dir, tokenProvider: token, fetch: f.fetch, sleep: noSleep, now: () => new Date("2026-10-02T08:00:00Z") });
    const r = await financeRange(svc, "2026-08", "2026-09");
    expect(r.months.map((m) => m.total)).toEqual([1, 1]);
    expect(r.total).toBe(2);
    expect(r.totalMicros).toBe(2_008_000);
    expect(r.notes.join(" ")).toMatch(/sum of the month totals.*2\.01/);
  });
});

describe("API warnings", () => {
  it("are passed on in the notes of financeRange and financeForecast", async () => {
    const range = await financeRange(service(warnedReport({ MONTH: ["202609"] })).svc, "2026-08", "2026-09");
    expect(range.notes).toContain("API warning: Data for 2026-09-30 is delayed.");
    const forecast = await financeForecast(service(warnedReport()).svc);
    expect(forecast.notes).toContain("API warning: Data for 2026-09-30 is delayed.");
  });
});
