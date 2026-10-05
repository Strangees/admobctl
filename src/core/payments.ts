import { AdmobctlError } from "./errors.js";
import { microsToAmount } from "./money.js";
import type { AdmobService } from "./service.js";

export const BALANCE_NOTE =
  "Unpaid balance from Google payments (AdSense Management API). It includes AdMob earnings. Payment history is not available: the API leaves out AdMob payouts.";

export interface FinanceBalance {
  /** Publisher ID, pub-… */
  account: string;
  /** The payments account's currency, as the API formats it. */
  currency: string;
  unpaid: number;
  unpaidMicros: number;
  notes: string[];
}

/** The live API separates currency and number with a no-break space (U+00A0); accept the usual space variants. */
const AMOUNT = /^(-)?([A-Z]{3})[ \u00a0\u202f](-)?(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,6}))?$/;

/** "NOK 12,345.67" → { currency: "NOK", micros: 12_345_670_000 }, with integer arithmetic only. */
export function parseAmount(text: string): { currency: string; micros: number } {
  const m = AMOUNT.exec(text);
  const micros = m ? BigInt(m[4]!.replace(/,/g, "")) * 1_000_000n + BigInt((m[5] ?? "").padEnd(6, "0")) : undefined;
  if (!m || micros === undefined || micros > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AdmobctlError("API_ERROR", `Unrecognized payment amount "${text}" from the AdSense Management API.`, {
      fix: "Please report the amount's format (not its value) at https://github.com/Strangees/admobctl/issues",
    });
  }
  const n = Number(micros);
  return { currency: m[2]!, micros: m[1] || m[3] ? -n : n };
}

/** The current unpaid balance. Paid entries are ignored: the API omits AdMob payouts from them. */
export async function financeBalance(svc: AdmobService): Promise<FinanceBalance> {
  const acct = await svc.account();
  const unpaid = (await svc.client.listPayments(acct.name)).find((p) => p.name.endsWith("/payments/unpaid"));
  const { currency, micros } = unpaid ? parseAmount(unpaid.amount) : { currency: acct.currencyCode, micros: 0 };
  return {
    account: acct.publisherId,
    currency,
    unpaid: microsToAmount(micros),
    unpaidMicros: micros,
    notes: unpaid ? [BALANCE_NOTE] : ["No unpaid balance reported.", BALANCE_NOTE],
  };
}
