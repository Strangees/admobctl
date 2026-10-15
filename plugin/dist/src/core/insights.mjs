import { usageError } from "./errors.mjs";
import { dateRangeFromArgs, formatDate, lastNDays, todayIn } from "./dates.mjs";
import { formatMicros, microsToAmount, sumMicros } from "./money.mjs";
import { ESTIMATE_LABEL } from "./finance.mjs";

//#region src/core/insights.ts
const INSIGHT_DIMENSIONS = [
	"app",
	"ad-unit",
	"country",
	"format",
	"platform"
];
const DIM_API = {
	app: "APP",
	"ad-unit": "AD_UNIT",
	country: "COUNTRY",
	format: "FORMAT",
	platform: "PLATFORM"
};
function aggregate(report, dim, labelOf) {
	const out = /* @__PURE__ */ new Map();
	for (const row of report.rows) {
		const d = row.dimensions[dim];
		const key = d?.value ?? "(unknown)";
		const label = labelOf(key, d?.label) ?? d?.label ?? key;
		const a = out.get(key) ?? {
			key,
			label,
			earnings: 0,
			requests: 0,
			matched: 0,
			impressions: 0,
			clicks: 0
		};
		a.earnings += row.metrics.ESTIMATED_EARNINGS ?? 0;
		a.requests += row.metrics.AD_REQUESTS ?? 0;
		a.matched += row.metrics.MATCHED_REQUESTS ?? 0;
		a.impressions += row.metrics.IMPRESSIONS ?? 0;
		a.clicks += row.metrics.CLICKS ?? 0;
		out.set(key, a);
	}
	return out;
}
const ratio = (a, b) => b > 0 ? a / b : 0;
/** Money per 1000 (eCPM, request RPM) as a rounded amount. */
const perMille = (micros, n) => microsToAmount(Math.round(ratio(micros, n) * 1e3));
const pct = (f) => `${(f * 100).toFixed(1)}%`;
const signedPct = (f) => `${f >= 0 ? "+" : ""}${(f * 100).toFixed(1)}%`;
/** --last N days (ending yesterday) or --from/--to. */
function resolveInsightRange(opts, today) {
	if (opts.from || opts.to) return dateRangeFromArgs(opts.from ?? opts.to, opts.to ?? opts.from);
	const days = opts.last ?? 30;
	if (!Number.isInteger(days) || days < 1 || days > 366) throw usageError("--last must be between 1d and 366d");
	return lastNDays(days, today);
}
async function insights(svc, opts) {
	if (!INSIGHT_DIMENSIONS.includes(opts.by)) throw usageError(`--by must be one of ${INSIGHT_DIMENSIONS.join(", ")}`);
	const acct = await svc.account();
	const range = resolveInsightRange(opts, todayIn(acct.reportingTimeZone, svc.now()));
	const metrics = [
		"earnings",
		"requests",
		"matched-requests",
		"impressions",
		"clicks"
	];
	const dim = DIM_API[opts.by];
	const [{ current: cur, previous: prev }, apps, units] = await Promise.all([
		svc.rawReportWithPrevious("network", {
			dateRange: range,
			by: [opts.by],
			metrics,
			currency: opts.currency
		}),
		opts.by === "app" ? svc.apps() : [],
		opts.by === "ad-unit" ? svc.adUnits() : []
	]);
	const prevRange = prev.range;
	const labelOf = (id, name) => {
		if (opts.by === "app") return apps.find((a) => a.appId === id)?.alias;
		const unit = units.find((u) => u.adUnitId === id);
		return unit ? `${unit.app} / ${name ?? unit.name}` : void 0;
	};
	const curAgg = aggregate(cur.report, dim, labelOf);
	const prevAgg = aggregate(prev.report, dim, labelOf);
	const total = sumMicros([...curAgg.values()].map((a) => a.earnings));
	const prevTotal = sumMicros([...prevAgg.values()].map((a) => a.earnings));
	const totalRequests = [...curAgg.values()].reduce((s, a) => s + a.requests, 0);
	const totalMatched = [...curAgg.values()].reduce((s, a) => s + a.matched, 0);
	const totalImpressions = [...curAgg.values()].reduce((s, a) => s + a.impressions, 0);
	const rows = [...curAgg.values()].sort((a, b) => b.earnings - a.earnings).map((a) => {
		const p = prevAgg.get(a.key);
		const row = {
			key: a.key,
			label: a.label,
			earnings: microsToAmount(a.earnings),
			earnings_micros: a.earnings,
			requests: a.requests,
			matched_requests: a.matched,
			impressions: a.impressions,
			clicks: a.clicks,
			ecpm: perMille(a.earnings, a.impressions),
			request_rpm: perMille(a.earnings, a.requests),
			match_rate: ratio(a.matched, a.requests),
			show_rate: ratio(a.impressions, a.matched),
			ctr: ratio(a.clicks, a.impressions),
			share: ratio(a.earnings, total)
		};
		if (p) {
			row.previous_earnings = microsToAmount(p.earnings);
			if (p.earnings > 0) row.change = (a.earnings - p.earnings) / p.earnings;
		}
		return row;
	});
	const currency = cur.report.currency ?? acct.currencyCode;
	const money = (micros) => `${formatMicros(micros)} ${currency}`;
	const highlights = [];
	const add = (kind, r, message) => highlights.push({
		kind,
		key: r.key,
		label: r.label,
		message
	});
	const topN = Math.min(3, Math.floor(rows.length / 2) || rows.length);
	const top = rows.slice(0, topN);
	for (const r of top) add("top", r, `${r.label} earned ${money(r.earnings_micros)} (${pct(r.share)} of total, eCPM ${r.ecpm.toFixed(2)}).`);
	const minRequests = Math.max(1e3, totalRequests * .05);
	const bottom = rows.slice(topN).filter((r) => r.requests >= 1e3).reverse().slice(0, 3);
	for (const r of bottom) add("bottom", r, `${r.label} earned only ${money(r.earnings_micros)} from ${r.requests} requests (request RPM ${r.request_rpm.toFixed(2)}).`);
	for (const r of rows) if (r.requests >= minRequests && r.match_rate < .5) add("low-fill", r, `${r.label} has low fill: ${pct(r.match_rate)} match rate on ${r.requests} requests.`);
	const minMatched = Math.max(1e3, totalMatched * .05);
	for (const r of rows) if (r.matched_requests >= minMatched && r.show_rate < .5) add("low-show-rate", r, `${r.label} shows only ${pct(r.show_rate)} of matched ads (${r.impressions} of ${r.matched_requests}); check when ads are loaded vs shown.`);
	const threshold = opts.swingThreshold ?? .3;
	const minSwing = Math.max(total * .01, 1e6);
	for (const r of rows) {
		const p = prevAgg.get(r.key)?.earnings ?? 0;
		const delta = r.earnings_micros - p;
		if (Math.abs(delta) < minSwing) continue;
		if (p === 0) add("new", r, `${r.label} is new this period: ${money(r.earnings_micros)}.`);
		else if (r.change !== void 0 && Math.abs(r.change) >= threshold) add(r.change > 0 ? "swing-up" : "swing-down", r, `${r.label} ${r.change > 0 ? "rose" : "fell"} ${signedPct(r.change)}: ${money(p)} → ${money(r.earnings_micros)}.`);
	}
	for (const p of prevAgg.values()) if (!curAgg.has(p.key) && p.earnings >= minSwing) add("gone", p, `${p.label} earned ${money(p.earnings)} last period and nothing this period.`);
	const change = prevTotal > 0 ? (total - prevTotal) / prevTotal : void 0;
	const from = formatDate(range.startDate);
	const to = formatDate(range.endDate);
	const summary = [
		`Estimated earnings ${money(total)} for ${from} → ${to}` + (change === void 0 ? "." : `, ${signedPct(change)} vs the previous period (${money(prevTotal)}).`),
		`Overall eCPM ${perMille(total, totalImpressions).toFixed(2)} ${currency}, match rate ${pct(ratio(totalMatched, totalRequests))}, show rate ${pct(ratio(totalImpressions, totalMatched))}.`,
		...highlights.filter((h) => h.kind !== "top" && h.kind !== "bottom").map((h) => h.message),
		...highlights.filter((h) => h.kind === "top").slice(0, 1).map((h) => `Top: ${h.message}`),
		ESTIMATE_LABEL
	];
	const totals = {
		earnings: microsToAmount(total),
		earnings_micros: total,
		requests: totalRequests,
		impressions: totalImpressions,
		ecpm: perMille(total, totalImpressions),
		match_rate: ratio(totalMatched, totalRequests),
		show_rate: ratio(totalImpressions, totalMatched)
	};
	if (change !== void 0) totals.change = change;
	return {
		by: opts.by,
		from,
		to,
		currency,
		timeZone: cur.report.timeZone ?? acct.reportingTimeZone,
		estimate: true,
		totals,
		previous: {
			from: formatDate(prevRange.startDate),
			to: formatDate(prevRange.endDate),
			earnings: microsToAmount(prevTotal),
			earnings_micros: prevTotal
		},
		rows,
		highlights,
		summary
	};
}

//#endregion
export { INSIGHT_DIMENSIONS, insights, pct, perMille, ratio, resolveInsightRange, signedPct };