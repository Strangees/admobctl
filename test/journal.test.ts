import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { describe, expect, it } from "vitest";
import type { TokenProvider } from "../src/core/auth/types.js";
import { saveConfig } from "../src/core/config.js";
import type { FinanceMonth } from "../src/core/finance.js";
import { accrualVoucher, exportJournal, journalCsv, journalDocument, journalRuleErrors, roleAccounts, type ExportQuery, type Voucher } from "../src/core/journal.js";
import { AdmobService } from "../src/core/service.js";
import { fakeFetch, fixture, jsonResponse, noSleep, synthReport } from "./helpers.js";

const SPEC = join(import.meta.dirname, "..", "spec");
const readJson = (p: string) => JSON.parse(readFileSync(join(SPEC, p), "utf8")) as unknown;

// ajv-formats is CommonJS; its default export arrives wrapped under ESM interop.
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as (a: Ajv2020) => void;
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
const schemaValid = ajv.compile(readJson("schema/revenue-journal-1.json") as object);

/** Full conformance check: the JSON Schema plus the rules a schema cannot express. */
function conformanceErrors(doc: unknown): string[] {
  if (!schemaValid(doc)) return (schemaValid.errors ?? []).map((e) => `RJ-SCHEMA ${e.instancePath} ${e.message}`);
  return journalRuleErrors(doc);
}

describe("Revenue Journal spec", () => {
  it("accepts every example", () => {
    for (const f of readdirSync(join(SPEC, "examples")).filter((n) => n.endsWith(".json"))) {
      expect(conformanceErrors(readJson(`examples/${f}`)), f).toEqual([]);
    }
  });

  const manifest = readJson("conformance/manifest.json") as { fixtures: Array<{ file: string; valid: boolean; rule: string | null }> };
  for (const fx of manifest.fixtures) {
    it(`${fx.valid ? "accepts" : `rejects (${fx.rule})`} conformance/${fx.file}`, () => {
      const errors = conformanceErrors(readJson(`conformance/${fx.file}`));
      if (fx.valid) expect(errors).toEqual([]);
      // A schema-level failure counts for rules the schema enforces (SPEC.md §4).
      else expect(errors.some((e) => e.startsWith(fx.rule!) || e.startsWith("RJ-SCHEMA")), errors.join("; ")).toBe(true);
    });
  }

  it("names the rule a schema-valid document breaks", () => {
    const doc = readJson("conformance/invalid/unbalanced.json");
    expect(journalRuleErrors(doc)).toEqual([expect.stringMatching(/^RJ-BALANCE /)]);
  });
});

const september: FinanceMonth = {
  month: "2026-09",
  from: "2026-09-01",
  to: "2026-09-30",
  bookingDate: "2026-09-30",
  currency: "NOK",
  timeZone: "Europe/Oslo",
  complete: true,
  estimate: true,
  total: 102.45,
  totalMicros: 102_450_000,
  apps: [
    { alias: "example-quiz-ios", name: "Example Quiz", appId: "ca-app-pub-0000000000000001~1111111111", earnings: 60.13, earningsMicros: 60_125_000 },
    { alias: "example-quiz-android", name: "Example Quiz", appId: "ca-app-pub-0000000000000001~2222222222", earnings: 42.32, earningsMicros: 42_325_000 },
    { alias: "sample-timer-ios", name: "Sample Timer", appId: "ca-app-pub-0000000000000001~3333333333", earnings: 0, earningsMicros: 1_000 },
  ],
  notes: [],
};
const ctx = { publisherId: "pub-0000000000000001", counterparty: "Google Ireland Limited", roles: roleAccounts(undefined) };

type Doc = {
  amounts?: unknown;
  vouchers: Array<{
    voucher_id: string;
    date: string;
    period: { from: string; to: string };
    counterparty?: string;
    lines: Array<{ role: string; debit?: unknown; credit?: unknown; dimension?: string }>;
  }>;
};

describe("accrualVoucher", () => {
  it("debits the receivable for the month and credits revenue per app, with a stable ID", () => {
    const v = accrualVoucher(september, ctx)!;
    expect(v).toMatchObject({
      voucher_id: "admob:pub-0000000000000001:accrual:2026-09",
      kind: "accrual",
      date: "2026-09-30",
      period: { from: "2026-09-01", to: "2026-09-30" },
      currency: "NOK",
      status: "estimate",
      source: "admob",
      description: "AdMob earnings, September 2026",
      counterparty: "Google Ireland Limited",
      account_ref: "pub-0000000000000001",
    });
    expect(v.lines).toEqual([
      { line: 1, role: "earnings_receivable", side: "debit", minor: 10245, account_name: "Accounts receivable – AdMob" },
      { line: 2, role: "revenue", side: "credit", minor: 6013, account_name: "Ad revenue – AdMob", dimension: "example-quiz-ios" },
      { line: 3, role: "revenue", side: "credit", minor: 4232, account_name: "Ad revenue – AdMob", dimension: "example-quiz-android" },
    ]);
  });

  it("leaves out apps that round to zero and months without earnings", () => {
    expect(accrualVoucher(september, ctx)!.lines.some((l) => l.dimension === "sample-timer-ios")).toBe(false);
    expect(accrualVoucher({ ...september, total: 0, totalMicros: 0, apps: [] }, ctx)).toBeUndefined();
  });

  it("uses account numbers and names only when the user configured them", () => {
    const v = accrualVoucher(september, {
      ...ctx,
      roles: roleAccounts({ receivableAccount: "1530", revenueAccount: "3125", revenueAccountName: "Salgsinntekt tjenester, utførsel" }),
    })!;
    expect(v.lines[0]).toMatchObject({ account: "1530", account_name: "Accounts receivable – AdMob" });
    expect(v.lines[1]).toMatchObject({ account: "3125", account_name: "Salgsinntekt tjenester, utførsel" });
    expect(accrualVoucher(september, ctx)!.lines[0]).not.toHaveProperty("account");
  });

  it("books an app that lost money as a revenue debit, so the voucher still balances", () => {
    const m: FinanceMonth = {
      ...september,
      total: 9.5,
      totalMicros: 9_500_000,
      apps: [
        { ...september.apps[0]!, earnings: 10, earningsMicros: 10_000_000 },
        { ...september.apps[1]!, earnings: -0.5, earningsMicros: -500_000 },
      ],
    };
    const v = accrualVoucher(m, ctx)!;
    expect(v.lines.map((l) => [l.line, l.role, l.side, l.minor, l.dimension])).toEqual([
      [1, "earnings_receivable", "debit", 950, undefined],
      [2, "revenue", "credit", 1000, "example-quiz-ios"],
      [3, "revenue", "debit", 50, "example-quiz-android"],
    ]);
    expect(conformanceErrors(journalDocument([v], {}))).toEqual([]);
  });

  it("credits the receivable when the month as a whole lost money", () => {
    const m: FinanceMonth = {
      ...september,
      total: -2,
      totalMicros: -2_000_000,
      apps: [
        { ...september.apps[0]!, earnings: 1, earningsMicros: 1_000_000 },
        { ...september.apps[1]!, earnings: -3, earningsMicros: -3_000_000 },
      ],
    };
    const v = accrualVoucher(m, ctx)!;
    expect(v.lines.map((l) => [l.role, l.side, l.minor])).toEqual([
      ["earnings_receivable", "credit", 200],
      ["revenue", "credit", 100],
      ["revenue", "debit", 300],
    ]);
    expect(conformanceErrors(journalDocument([v], {}))).toEqual([]);
  });

  it("gives a month that has not ended an ID of its own, dated at the last day it covers", () => {
    const october: FinanceMonth = { ...september, month: "2026-10", from: "2026-10-01", to: "2026-10-06", bookingDate: "2026-10-06", complete: false };
    expect(accrualVoucher(october, ctx)).toMatchObject({
      voucher_id: "admob:pub-0000000000000001:accrual:2026-10-01/2026-10-06",
      date: "2026-10-06",
      period: { from: "2026-10-01", to: "2026-10-06" },
      status: "estimate",
      description: "AdMob earnings, October 2026 (partial: 2026-10-01 to 2026-10-06)",
    });
  });

  it("names a counterparty only when one is given", () => {
    expect(accrualVoucher(september, { ...ctx, counterparty: undefined })).not.toHaveProperty("counterparty");
  });
});

describe("currencies whose minor unit is not two decimals", () => {
  const month = (currency: string, total: number, apps: [number, number]): FinanceMonth => ({
    ...september,
    currency,
    total,
    apps: [
      { ...september.apps[0]!, earnings: apps[0] },
      { ...september.apps[1]!, earnings: apps[1] },
    ],
  });

  it("writes JPY in whole yen, exactly at --scale 0", () => {
    const v = accrualVoucher(month("JPY", 1235, [1000, 235]), ctx)!;
    expect(v.lines.map((l) => l.minor)).toEqual([1235, 1000, 235]);
    const doc = journalDocument([v], {}) as Doc;
    expect(doc.vouchers[0]!.lines.map((l) => l.debit ?? l.credit)).toEqual(["1235", "1000", "235"]);
    expect(conformanceErrors(doc)).toEqual([]);
    const ints = journalDocument([v], { amounts: { encoding: "integer", scale: 0 } }) as Doc;
    expect(ints.vouchers[0]!.lines[0]!.debit).toBe(1235);
    expect(conformanceErrors(ints)).toEqual([]);
    expect(journalCsv([v])).toContain(",earnings_receivable,,Accounts receivable – AdMob,1235,,");
  });

  it("writes KWD with three decimals and refuses a scale below them", () => {
    const v = accrualVoucher(month("KWD", 1.235, [1, 0.235]), ctx)!;
    const doc = journalDocument([v], {}) as Doc;
    expect(doc.vouchers[0]!.lines.map((l) => l.debit ?? l.credit)).toEqual(["1.235", "1.000", "0.235"]);
    expect(conformanceErrors(doc)).toEqual([]);
    expect(() => journalDocument([v], { amounts: { encoding: "integer", scale: 2 } })).toThrow(/1\.235.*--scale 2; use --scale 3 or more/);
  });

  it("refuses integers that a JSON parser cannot read exactly", () => {
    const big: Voucher = {
      ...accrualVoucher(september, ctx)!,
      currency: "IDR",
      lines: [
        { line: 1, role: "earnings_receivable", side: "debit", minor: 90_071_992_547_410 },
        { line: 2, role: "revenue", side: "credit", minor: 90_071_992_547_410 },
      ],
    };
    expect(() => journalDocument([big], { amounts: { encoding: "integer", scale: 6 } })).toThrow(/too large for --scale 6.*--scale 2/);
    const two = journalDocument([big], { amounts: { encoding: "integer", scale: 2 } }) as Doc;
    expect(two.vouchers[0]!.lines[0]!.debit).toBe(90_071_992_547_410);
  });
});

describe("journalDocument", () => {
  const vouchers = [accrualVoucher(september, ctx)!];

  it("writes decimal strings by default and conforms to the spec", () => {
    const doc = journalDocument(vouchers, { producer: { name: "admobctl", version: "0.0.0" } }) as {
      amounts?: unknown;
      vouchers: Array<{ lines: Array<{ debit?: unknown; credit?: unknown }> }>;
    };
    expect(doc.amounts).toBeUndefined();
    expect(doc.vouchers[0]!.lines[0]!.debit).toBe("102.45");
    expect(doc.vouchers[0]!.lines[1]!.credit).toBe("60.13");
    expect(conformanceErrors(doc)).toEqual([]);
  });

  it("writes integers at the requested scale with the integer encoding", () => {
    const two = journalDocument(vouchers, { amounts: { encoding: "integer", scale: 2 } }) as {
      amounts: unknown;
      vouchers: Array<{ lines: Array<{ debit?: unknown; credit?: unknown }> }>;
    };
    expect(two.amounts).toEqual({ encoding: "integer", scale: 2 });
    expect(two.vouchers[0]!.lines[0]!.debit).toBe(10245);
    expect(conformanceErrors(two)).toEqual([]);

    const micros = journalDocument(vouchers, { amounts: { encoding: "integer", scale: 6 } }) as typeof two;
    expect(micros.vouchers[0]!.lines[0]!.debit).toBe(102_450_000);
    expect(conformanceErrors(micros)).toEqual([]);
  });

  it("refuses a scale that cannot hold the amounts exactly", () => {
    expect(() => journalDocument(vouchers, { amounts: { encoding: "integer", scale: 0 } })).toThrow(/102\.45.*--scale 0/);
    expect(() => journalDocument(vouchers, { amounts: { encoding: "integer", scale: 7 } })).toThrow(/between 0 and 6/);
  });

  it("writes an empty document when there are no vouchers", () => {
    expect(conformanceErrors(journalDocument([], {}))).toEqual([]);
  });
});

describe("journalCsv", () => {
  it("writes one row per line in the spec's column order, quoting where needed", () => {
    const v: Voucher = { ...accrualVoucher(september, ctx)!, description: 'AdMob "earnings", September 2026' };
    const rows = journalCsv([v]).trimEnd().split("\n");
    expect(rows[0]).toBe(
      "format,voucher_id,kind,date,period_from,period_to,currency,status,source,description,counterparty,account_ref,line,role,account,account_name,debit,credit,vat_code,line_description,dimension,foreign_currency,foreign_amount",
    );
    expect(rows).toHaveLength(4);
    expect(rows[1]).toBe(
      'revenue-journal/1,admob:pub-0000000000000001:accrual:2026-09,accrual,2026-09-30,2026-09-01,2026-09-30,NOK,estimate,admob,"AdMob ""earnings"", September 2026",Google Ireland Limited,pub-0000000000000001,1,earnings_receivable,,Accounts receivable – AdMob,102.45,,,,,,',
    );
    expect(rows[2]).toContain(",2,revenue,,Ad revenue – AdMob,,60.13,,,example-quiz-ios,,");
  });
});

describe("exportJournal", () => {
  const token: TokenProvider = { mode: "adc", getToken: async () => "t", quotaProject: () => "qp" };
  const QUIZ_IOS = "ca-app-pub-0000000000000001~1111111111";
  const QUIZ_ANDROID = "ca-app-pub-0000000000000001~2222222222";
  const byApp = (rows: Array<[app: string, micros: number]>, currency = "NOK") =>
    synthReport(rows.map(([app, micros]) => [{ APP: [app] }, { ESTIMATED_EARNINGS: micros }]), currency);
  const byMonthApp = (rows: Array<[month: string, app: string, micros: number]>) =>
    synthReport(rows.map(([month, app, micros]) => [{ MONTH: [month], APP: [app] }, { ESTIMATED_EARNINGS: micros }]));

  /** exportJournal against a fake API that answers every network report with `report`; now is 2026-10-02 in Oslo. */
  function exporter(report: unknown, finance?: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), "admobctl-rj-"));
    saveConfig(dir, { profiles: { default: finance ? { finance } : {} } });
    const f = fakeFetch({
      "GET /v1/accounts?": () => jsonResponse(fixture("accounts.json")),
      "GET /apps": (c) => jsonResponse(fixture(c.url.includes("pageToken=page2") ? "apps-page2.json" : "apps-page1.json")),
      "POST /networkReport:generate": () => jsonResponse(report),
    });
    const svc = AdmobService.create({}, { configDir: dir, tokenProvider: token, fetch: f.fetch, sleep: noSleep, now: () => new Date("2026-10-02T08:00:00Z") });
    const run = async (q: Omit<ExportQuery, "as">) => {
      const r = await exportJournal(svc, { as: "revenue-journal-json", ...q });
      return { ...r, doc: JSON.parse(r.content) as Doc };
    };
    const reportSpecs = () =>
      f.calls.filter((c) => c.url.includes("networkReport")).map((c) => (c.body as { reportSpec: { dateRange: unknown } }).reportSpec);
    return { run, reportSpecs };
  }

  it("writes a conforming, balanced document when an app lost money", async () => {
    const { run } = exporter(byApp([[QUIZ_IOS, 10_000_000], [QUIZ_ANDROID, -500_000]]));
    const { doc } = await run({ month: "2026-09" });
    expect(doc.vouchers[0]!.lines.map((l) => [l.role, l.debit ?? `-${String(l.credit)}`])).toEqual([
      ["earnings_receivable", "9.50"],
      ["revenue", "-10.00"],
      ["revenue", "0.50"],
    ]);
    expect(conformanceErrors(doc)).toEqual([]);
    expect(conformanceErrors((await run({ month: "2026-09", integerAmounts: true })).doc)).toEqual([]);
  });

  it("writes JPY in whole yen, with the integer scale defaulting to the currency's minor unit", async () => {
    const { run } = exporter(byApp([[QUIZ_IOS, 1_000_400_000], [QUIZ_ANDROID, 234_570_000]], "JPY"));
    const { doc } = await run({ month: "2026-09" });
    expect(doc.vouchers[0]!.lines.map((l) => l.debit ?? l.credit)).toEqual(["1235", "1000", "235"]);
    expect(conformanceErrors(doc)).toEqual([]);
    const ints = (await run({ month: "2026-09", integerAmounts: true })).doc;
    expect(ints.amounts).toEqual({ encoding: "integer", scale: 0 });
    expect(ints.vouchers[0]!.lines[0]!.debit).toBe(1235);
    expect(conformanceErrors(ints)).toEqual([]);
    expect((await run({ month: "2026-09", integerAmounts: true, scale: 0 })).doc.vouchers[0]!.lines[0]!.debit).toBe(1235);
  });

  it("refuses a month that has not ended, and names the way out", async () => {
    const { run, reportSpecs } = exporter(byApp([[QUIZ_IOS, 5_000_000]]));
    await expect(run({ month: "2026-10" })).rejects.toThrow(/2026-10 has not ended.*2026-09.*--allow-incomplete/);
    await expect(run({ from: "2026-09", to: "2026-10" })).rejects.toThrow(/2026-10 has not ended/);
    expect(reportSpecs()).toEqual([]);
  });

  it("with allowIncomplete, exports a partial voucher through yesterday under an ID of its own", async () => {
    const { run, reportSpecs } = exporter(byApp([[QUIZ_IOS, 5_000_000]]));
    const { doc, notes } = await run({ month: "2026-10", allowIncomplete: true });
    expect(reportSpecs()[0]!.dateRange).toEqual({ startDate: { year: 2026, month: 10, day: 1 }, endDate: { year: 2026, month: 10, day: 1 } });
    expect(doc.vouchers[0]).toMatchObject({
      voucher_id: "admob:pub-0000000000000001:accrual:2026-10-01/2026-10-01",
      date: "2026-10-01",
      period: { from: "2026-10-01", to: "2026-10-01" },
    });
    expect(conformanceErrors(doc)).toEqual([]);
    expect(notes.join(" ")).toMatch(/partial.*reverse.*admob:pub-0000000000000001:accrual:2026-10\b/i);
  });

  it("with allowIncomplete, ends a range at yesterday and keeps the IDs of complete months", async () => {
    const { run, reportSpecs } = exporter(byMonthApp([["202609", QUIZ_IOS, 7_000_000], ["202610", QUIZ_IOS, 5_000_000]]));
    const { doc } = await run({ from: "2026-09", to: "2026-10", allowIncomplete: true });
    expect(reportSpecs()[0]!.dateRange).toEqual({ startDate: { year: 2026, month: 9, day: 1 }, endDate: { year: 2026, month: 10, day: 1 } });
    expect(doc.vouchers.map((v) => [v.voucher_id, v.period.to])).toEqual([
      ["admob:pub-0000000000000001:accrual:2026-09", "2026-09-30"],
      ["admob:pub-0000000000000001:accrual:2026-10-01/2026-10-01", "2026-10-01"],
    ]);
    expect(conformanceErrors(doc)).toEqual([]);
  });

  it("refuses a month without a complete day even with allowIncomplete", async () => {
    const { run } = exporter(byApp([]));
    await expect(run({ month: "2026-11", allowIncomplete: true })).rejects.toThrow(/2026-11 has no complete day yet/);
  });

  it("names the counterparty only when the user configured one", async () => {
    const plain = await exporter(byApp([[QUIZ_IOS, 5_000_000]])).run({ month: "2026-09" });
    expect(plain.doc.vouchers[0]).not.toHaveProperty("counterparty");
    const configured = await exporter(byApp([[QUIZ_IOS, 5_000_000]]), { counterparty: "Google Asia Pacific Pte. Ltd." }).run({ month: "2026-09" });
    expect(configured.doc.vouchers[0]!.counterparty).toBe("Google Asia Pacific Pte. Ltd.");
  });

  it("passes the API's warnings on in the notes", async () => {
    const report = byApp([[QUIZ_IOS, 5_000_000]]);
    report[report.length - 1] = { footer: { matchingRowCount: "1", warnings: [{ type: "DATA_DELAYED", description: "Data for 2026-09-30 is delayed." }] } } as never;
    const { notes } = await exporter(report).run({ month: "2026-09" });
    expect(notes).toContain("API warning: Data for 2026-09-30 is delayed.");
  });
});
