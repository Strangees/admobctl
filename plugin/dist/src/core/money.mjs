//#region src/core/money.ts
/**
* Money is carried as integer micros (1 unit = 1_000_000 micros) from the API
* response all the way to the output layer. Rounding happens only here.
*/
function parseMicros(value) {
	if (value === void 0 || value === null || value === "") return 0;
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n)) throw new Error(`Invalid micros value: ${String(value)}`);
	if (!Number.isSafeInteger(n)) throw new Error(`Micros value ${String(value)} exceeds safe integer precision`);
	return n;
}
function sumMicros(values) {
	let total = 0;
	for (const v of values) total += v;
	if (!Number.isSafeInteger(total)) throw new Error("Micros sum exceeds safe integer precision");
	return total;
}
/** Round half away from zero to `decimals` places, using integer arithmetic only. */
function formatMicros(micros, decimals = 2) {
	if (decimals < 0 || decimals > 6) throw new Error("decimals must be between 0 and 6");
	const scale = 10 ** (6 - decimals);
	const negative = micros < 0;
	const abs = Math.abs(micros);
	let units = Math.floor(abs / scale);
	if (abs % scale * 2 >= scale) units += 1;
	const s = String(units).padStart(decimals + 1, "0");
	const out = `${decimals === 0 ? s : s.slice(0, -decimals)}${decimals === 0 ? "" : `.${s.slice(-decimals)}`}`;
	return negative && units !== 0 ? `-${out}` : out;
}
function microsToAmount(micros, decimals = 2) {
	return Number(formatMicros(micros, decimals));
}

//#endregion
export { formatMicros, microsToAmount, parseMicros, sumMicros };