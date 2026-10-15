import { usageError } from "./errors.mjs";
import { formatMicros, microsToAmount, sumMicros } from "./money.mjs";
import { ESTIMATE_LABEL } from "./finance.mjs";
import { pct, perMille, ratio } from "./insights.mjs";
import { fetchReport } from "./analyze.mjs";

//#region src/core/geo.ts
const DEFAULT_MIN_REQUESTS = 1e3;
/** A cell is "big" from this share of its format's requests, and "small" below it. */
const SHARE = .05;
async function analyzeGeo(svc, opts = {}) {
	const minRequests = opts.minRequests ?? DEFAULT_MIN_REQUESTS;
	if (!Number.isInteger(minRequests) || minRequests < 1) throw usageError("--min-requests must be a positive whole number");
	const r = await fetchReport(svc, "network", {
		...opts,
		by: ["COUNTRY", "FORMAT"],
		metrics: [
			"ESTIMATED_EARNINGS",
			"AD_REQUESTS",
			"MATCHED_REQUESTS",
			"IMPRESSIONS"
		],
		filters: opts.app ? { app: [opts.app] } : void 0
	});
	const cells = r.report.rows.map((row) => ({
		country: row.dimensions.COUNTRY?.value ?? "(unknown)",
		format: row.dimensions.FORMAT?.label ?? row.dimensions.FORMAT?.value ?? "(unknown)",
		earnings: row.metrics.ESTIMATED_EARNINGS ?? 0,
		requests: row.metrics.AD_REQUESTS ?? 0,
		matched: row.metrics.MATCHED_REQUESTS ?? 0,
		impressions: row.metrics.IMPRESSIONS ?? 0
	}));
	const total = sumMicros(cells.map((c) => c.earnings));
	const sumBy = (key) => {
		const out = /* @__PURE__ */ new Map();
		for (const c of cells) {
			const s = out.get(c[key]) ?? {
				earnings: 0,
				requests: 0,
				matched: 0,
				impressions: 0
			};
			s.earnings += c.earnings;
			s.requests += c.requests;
			s.matched += c.matched;
			s.impressions += c.impressions;
			out.set(c[key], s);
		}
		return out;
	};
	const formats = sumBy("format");
	const byCountry = sumBy("country");
	const rows = cells.sort((a, b) => b.earnings - a.earnings || b.requests - a.requests).map((c) => {
		const f = formats.get(c.format);
		const row = {
			country: c.country,
			format: c.format,
			earnings: microsToAmount(c.earnings),
			earnings_micros: c.earnings,
			earnings_share: ratio(c.earnings, total),
			requests: c.requests,
			format_request_share: ratio(c.requests, f.requests),
			impressions: c.impressions,
			match_rate: ratio(c.matched, c.requests),
			show_rate: ratio(c.impressions, c.matched),
			ecpm: perMille(c.earnings, c.impressions),
			enough_data: c.requests >= minRequests
		};
		if (f.earnings > 0 && f.impressions > 0 && c.impressions > 0) row.ecpm_vs_format = ratio(c.earnings / c.impressions, f.earnings / f.impressions);
		return row;
	});
	const countries = [...byCountry.entries()].sort((a, b) => b[1].earnings - a[1].earnings || b[1].requests - a[1].requests).map(([country, s]) => ({
		country,
		earnings: microsToAmount(s.earnings),
		earnings_micros: s.earnings,
		earnings_share: ratio(s.earnings, total),
		requests: s.requests,
		ecpm: perMille(s.earnings, s.impressions)
	}));
	const highlights = [];
	const top = countries[0];
	if (top && countries.length > 1 && top.earnings_share >= .5) highlights.push({
		kind: "concentration",
		key: top.country,
		label: top.country,
		message: `${top.country} brings ${pct(top.earnings_share)} of earnings (${formatMicros(top.earnings_micros)} ${r.currency}); a change there moves the whole account.`
	});
	for (const [i, row] of rows.entries()) {
		if (!row.enough_data) continue;
		const c = cells[i];
		const f = formats.get(row.format);
		const key = `${row.country} ${row.format}`;
		const elsewhere = ratio(f.matched - c.matched, f.requests - c.requests);
		if (row.format_request_share >= SHARE && f.requests - c.requests >= minRequests && row.match_rate < .7 * elsewhere) highlights.push({
			kind: "low-fill",
			key,
			label: key,
			message: `${key} fills ${pct(row.match_rate)} of ${row.requests} requests; ${row.format} fills ${pct(elsewhere)} elsewhere. Check mediation coverage and floors for ${row.country}.`
		});
		if (row.ecpm_vs_format !== void 0 && row.ecpm_vs_format >= 1.5 && row.format_request_share < SHARE) highlights.push({
			kind: "high-ecpm",
			key,
			label: key,
			message: `${key} pays eCPM ${row.ecpm.toFixed(2)} ${r.currency}, ${row.ecpm_vs_format.toFixed(1)}× the ${row.format} average, on only ${pct(row.format_request_share)} of ${row.format} requests: more users there are worth more.`
		});
	}
	const thin = rows.filter((x) => !x.enough_data).length;
	const summary = rows.length ? [
		`Estimated earnings ${formatMicros(total)} ${r.currency} from ${countries.length} ${countries.length === 1 ? "country" : "countries"} and ${formats.size} ${formats.size === 1 ? "format" : "formats"}, ${r.from} → ${r.to}.`,
		...highlights.length ? highlights.map((h) => h.message) : ["No country and format with enough traffic stands out on fill or eCPM."],
		ESTIMATE_LABEL
	] : [`No ad traffic ${r.from} → ${r.to}.`];
	return {
		from: r.from,
		to: r.to,
		timeZone: r.timeZone,
		currency: r.currency,
		estimate: true,
		rows,
		countries,
		highlights,
		summary,
		notices: [...r.notices, ...thin ? [`${thin} of ${rows.length} country and format rows had fewer than ${minRequests} requests; treat their rates and eCPM as noise, not findings.`] : []]
	};
}

//#endregion
export { analyzeGeo };