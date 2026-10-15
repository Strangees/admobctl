import { AdmobctlError } from "./errors.mjs";
import { microsToAmount } from "./money.mjs";

//#region src/core/payments.ts
const BALANCE_NOTE = "Unpaid balance from Google payments (AdSense Management API). It includes AdMob earnings. Payment history is not available: the API leaves out AdMob payouts.";
/** The live API separates currency and number with a no-break space (U+00A0); accept the usual space variants. */
const AMOUNT = /^(-)?([A-Z]{3})[ \u00a0\u202f](-)?(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,6}))?$/;
/** "NOK 12,345.67" → { currency: "NOK", micros: 12_345_670_000 }, with integer arithmetic only. */
function parseAmount(text) {
	const m = AMOUNT.exec(text);
	const micros = m ? BigInt(m[4].replace(/,/g, "")) * 1000000n + BigInt((m[5] ?? "").padEnd(6, "0")) : void 0;
	if (!m || micros === void 0 || micros > BigInt(Number.MAX_SAFE_INTEGER)) throw new AdmobctlError("API_ERROR", `Unrecognized payment amount "${text}" from the AdSense Management API.`, { fix: "Please report the amount's format (not its value) at https://github.com/Strangees/admobctl/issues" });
	const n = Number(micros);
	return {
		currency: m[2],
		micros: m[1] || m[3] ? -n : n
	};
}
/** The current unpaid balance. Paid entries are ignored: the API omits AdMob payouts from them. */
async function financeBalance(svc) {
	const acct = await svc.account();
	const unpaid = (await svc.client.listPayments(acct.name)).find((p) => p.name.endsWith("/payments/unpaid"));
	const { currency, micros } = unpaid ? parseAmount(unpaid.amount) : {
		currency: acct.currencyCode,
		micros: 0
	};
	return {
		account: acct.publisherId,
		currency,
		unpaid: microsToAmount(micros),
		unpaidMicros: micros,
		notes: unpaid ? [BALANCE_NOTE] : ["No unpaid balance reported.", BALANCE_NOTE]
	};
}

//#endregion
export { BALANCE_NOTE, financeBalance, parseAmount };