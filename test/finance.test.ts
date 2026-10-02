import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allocateRounded, financeMonth, financeRange, journalRows } from "../src/core/finance.js";
import { saveConfig } from "../src/core/config.js";
import { AdmobService } from "../src/core/service.js";
import type { TokenProvider } from "../src/core/auth/types.js";
import { fakeFetch, fixture, jsonResponse, noSleep } from "./helpers.js";

const token: TokenProvider = { mode: "adc", getToken: async () => "t", quotaProject: () => "qp" };

function service(reportFixture: string, profile: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "admobctl-fin-"));
  saveConfig(dir, { profiles: { default: profile } });
  const f = fakeFetch({
    "GET /v1/accounts?": () => jsonResponse(fixture("accounts.json")),
    "GET /apps": (c) => jsonResponse(fixture(c.url.includes("pageToken=page2") ? "apps-page2.json" : "apps-page1.json")),
    "POST /networkReport:generate": () => jsonResponse(fixture(reportFixture)),
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
});

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
});
