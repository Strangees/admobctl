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
