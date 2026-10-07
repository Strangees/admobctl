/**
 * Money is carried as integer micros (1 unit = 1_000_000 micros) from the API
 * response all the way to the output layer. Rounding happens only here.
 */

export function parseMicros(value: string | number | undefined | null): number {
  if (value === undefined || value === null || value === "") return 0;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new Error(`Invalid micros value: ${String(value)}`);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`Micros value ${String(value)} exceeds safe integer precision`);
  }
  return n;
}

export function sumMicros(values: Iterable<number>): number {
  let total = 0;
  for (const v of values) total += v;
  if (!Number.isSafeInteger(total)) throw new Error("Micros sum exceeds safe integer precision");
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

/**
 * ISO 4217 currencies whose minor unit is not two decimals. A table, not Intl: Intl gives CLDR's display digits,
 * which differ from ISO 4217 (IQD, LBP) and change between ICU versions (IDR), so the same export would come out
 * differently on another Node version.
 */
const MINOR_UNIT_DIGITS: Readonly<Record<string, number>> = {
  ...Object.fromEntries(
    ["BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF"].map((c) => [c, 0]),
  ),
  ...Object.fromEntries(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"].map((c) => [c, 3])),
  CLF: 4,
  UYW: 4,
};

/** Decimals of a currency's minor unit (ISO 4217): 2 for NOK, USD and IDR, 0 for JPY and KRW, 3 for KWD; 2 when unknown. */
export function currencyDigits(currency: string): number {
  return MINOR_UNIT_DIGITS[currency.toUpperCase()] ?? 2;
}
