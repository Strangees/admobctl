import { AdmobctlError } from "./errors.js";

/**
 * Money is carried as integer micros (1 unit = 1_000_000 micros) from the API
 * response all the way to the output layer. Rounding happens only here.
 */

/**
 * Integer micros stay exact up to about 9 billion currency units: reachable for a year of earnings in a currency
 * with small units (VND, IDR). Past that, refuse rather than round. No fix: which command to narrow is the caller's.
 */
function tooLarge(what: string): AdmobctlError {
  return new AdmobctlError(
    "AMOUNT_TOO_LARGE",
    `${what} is too large to keep exact (integer precision ends near 9 billion in the report's currency). Narrow the date range (e.g. a month at a time), or report in a larger currency with --currency USD where the command takes it.`,
  );
}

export function parseMicros(value: string | number | undefined | null): number {
  if (value === undefined || value === null || value === "") return 0;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n)) {
    throw new AdmobctlError("API_ERROR", `The AdMob API sent an invalid money value: ${String(value)}`, {
      fix: "Retry in a few minutes.",
    });
  }
  if (!Number.isSafeInteger(n)) throw tooLarge(`The amount ${String(value)} micros`);
  return n;
}

export function sumMicros(values: Iterable<number>): number {
  let total = 0;
  for (const v of values) {
    total += v;
    // Checked at every step: a sum that passes the limit loses precision even if it ends below it.
    if (!Number.isSafeInteger(total)) throw tooLarge("The total");
  }
  return total;
}

/** Round half away from zero to `decimals` places, using integer arithmetic only. */
export function formatMicros(micros: number, decimals = 2): string {
  if (decimals < 0 || decimals > 6) throw new Error("decimals must be between 0 and 6");
  const scale = 10 ** (6 - decimals);
  const negative = micros < 0;
  const abs = Math.abs(micros);
  let units = Math.floor(abs / scale);
  if ((abs % scale) * 2 >= scale) units += 1;
  const s = String(units).padStart(decimals + 1, "0");
  const intPart = decimals === 0 ? s : s.slice(0, -decimals);
  const frac = decimals === 0 ? "" : `.${s.slice(-decimals)}`;
  const out = `${intPart}${frac}`;
  return negative && units !== 0 ? `-${out}` : out;
}

export function microsToAmount(micros: number, decimals = 2): number {
  return Number(formatMicros(micros, decimals));
}
