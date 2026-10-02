import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { describe, expect, it } from "vitest";
import type { FinanceMonth } from "../src/core/finance.js";
import { accrualVoucher, journalCsv, journalDocument, journalRuleErrors, roleAccounts, type Voucher } from "../src/core/journal.js";

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
      { line: 1, role: "earnings_receivable", side: "debit", cents: 10245, account_name: "Accounts receivable – AdMob" },
      { line: 2, role: "revenue", side: "credit", cents: 6013, account_name: "Ad revenue – AdMob", dimension: "example-quiz-ios" },
      { line: 3, role: "revenue", side: "credit", cents: 4232, account_name: "Ad revenue – AdMob", dimension: "example-quiz-android" },
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
