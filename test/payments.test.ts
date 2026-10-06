import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TokenProvider } from "../src/core/auth/types.js";
import { saveConfig } from "../src/core/config.js";
import { AdmobctlError } from "../src/core/errors.js";
import { BALANCE_NOTE, financeBalance, parseAmount } from "../src/core/payments.js";
import { AdmobService } from "../src/core/service.js";
import { fakeFetch, fixture, jsonResponse, noSleep } from "./helpers.js";

const token: TokenProvider = { mode: "adc", getToken: async () => "t", quotaProject: () => "qp" };

function service(payments: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "admobctl-pay-"));
  saveConfig(dir, { profiles: { default: {} } });
  const f = fakeFetch({
    "GET /v1/accounts?": () => jsonResponse(fixture("accounts.json")),
    "GET /v2/accounts/": () => jsonResponse(payments),
  });
  const svc = AdmobService.create({}, { configDir: dir, tokenProvider: token, fetch: f.fetch, sleep: noSleep });
  return { svc, calls: f.calls };
}

describe("parseAmount", () => {
  it("parses the API's formatted amounts into exact micros", () => {
    expect(parseAmount("NOK 98.76")).toEqual({ currency: "NOK", micros: 98_760_000 });
    expect(parseAmount("NOK 12,345.67")).toEqual({ currency: "NOK", micros: 12_345_670_000 });
    expect(parseAmount("USD 0.5")).toEqual({ currency: "USD", micros: 500_000 });
    expect(parseAmount("EUR 7")).toEqual({ currency: "EUR", micros: 7_000_000 });
  });

  it("accepts the non-breaking space the live API puts between currency and number", () => {
    expect(parseAmount("NOK\u00a098.76")).toEqual({ currency: "NOK", micros: 98_760_000 });
    expect(parseAmount("NOK\u202f1,234.56")).toEqual({ currency: "NOK", micros: 1_234_560_000 });
  });

  it("accepts a minus sign before the currency or before the number", () => {
    expect(parseAmount("-NOK 5.00")).toEqual({ currency: "NOK", micros: -5_000_000 });
    expect(parseAmount("NOK -5.00")).toEqual({ currency: "NOK", micros: -5_000_000 });
  });

  it("rejects formats it cannot read exactly, with an AdmobctlError and a fix", () => {
    for (const bad of ["kr 5,00", "NOK 1.2345678", "NOK", "NOK 1,23.00", ""]) {
      let err: unknown;
      try {
        parseAmount(bad);
      } catch (e) {
        err = e;
      }
      expect(err, bad).toBeInstanceOf(AdmobctlError);
      expect((err as AdmobctlError).code).toBe("API_ERROR");
      expect((err as AdmobctlError).message).toMatch(/Unrecognized payment amount/);
      expect((err as AdmobctlError).fix).toBeTruthy();
    }
  });
});

describe("financeBalance", () => {
  it("returns the unpaid entry in micros and ignores paid payments", async () => {
    const { svc, calls } = service(fixture("adsense-payments.json"));
    expect(await financeBalance(svc)).toEqual({
      account: "pub-0000000000000001",
      currency: "NOK",
      unpaid: 1234.56,
      unpaidMicros: 1_234_560_000,
      notes: [BALANCE_NOTE],
    });
    expect(calls.some((c) => c.url.includes("/v2/accounts/pub-0000000000000001/payments"))).toBe(true);
  });

  it.each([[{ payments: [] }], [{}]])("reports 0 in the account currency when there is no unpaid entry (%j)", async (body) => {
    const { svc } = service(body);
    const b = await financeBalance(svc);
    expect(b).toMatchObject({ account: "pub-0000000000000001", currency: "NOK", unpaid: 0, unpaidMicros: 0 });
    expect(b.notes).toContain("No unpaid balance reported.");
    expect(b.notes).toContain(BALANCE_NOTE);
  });
});
