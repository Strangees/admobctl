import { usageError } from "./errors.mjs";
import { addDays, formatDate, lastNDays, todayIn } from "./dates.mjs";
import { formatMicros, microsToAmount } from "./money.mjs";
import { ESTIMATE_LABEL } from "./finance.mjs";
import { pct, ratio } from "./insights.mjs";

//#region src/core/check.ts
const CHECK_DEFAULTS = {
	window: 1,
	baseline: 7,
	drop: .3,
	minRequests: 1e3
};
const ZERO = {
	earnings: 0,
	requests: 0,
	matched: 0,
	impressions: 0
};
function sumByApp(report) {
	const out = /* @__PURE__ */ new Map();
	for (const row of report.rows) {
		const id = row.dimensions.APP?.value ?? "unknown";
		const s = out.get(id) ?? { ...ZERO };
		s.earnings += row.metrics.ESTIMATED_EARNINGS ?? 0;
		s.requests += row.metrics.AD_REQUESTS ?? 0;
		s.matched += row.metrics.MATCHED_REQUESTS ?? 0;
		s.impressions += row.metrics.IMPRESSIONS ?? 0;
		out.set(id, s);
	}
	return out;
}
const add = (a, b) => ({
	earnings: a.earnings + b.earnings,
	requests: a.requests + b.requests,
	matched: a.matched + b.matched,
	impressions: a.impressions + b.impressions
});
function wholeNumber(value, configured, fallback, name, max) {
	const n = value ?? (configured === void 0 ? fallback : Number(configured));
	if (!Number.isInteger(n) || n < 1 || n > max) throw usageError(`${name} must be a whole number between 1 and ${max}, got "${value ?? configured}"`);
	return n;
}
async function check(svc, opts = {}) {
	const cfg = svc.profile.check ?? {};
	const windowDays = wholeNumber(opts.window, cfg.window, CHECK_DEFAULTS.window, "The window (--window, check.window) in days", 90);
	const baselineDays = wholeNumber(opts.baseline, cfg.baseline, CHECK_DEFAULTS.baseline, "The baseline (--baseline, check.baseline) in days", 366);
	const dropPercent = opts.drop !== void 0 ? opts.drop * 100 : cfg.drop === void 0 ? CHECK_DEFAULTS.drop * 100 : Number(cfg.drop);
	if (!(dropPercent >= 1 && dropPercent <= 99)) throw usageError("The drop threshold (--drop, check.drop) must be between 1 and 99 (percent).");
	const drop = dropPercent / 100;
	const minRequests = wholeNumber(opts.minRequests, cfg.minRequests, CHECK_DEFAULTS.minRequests, "The minimum requests (--min-requests, check.minRequests)", 1e9);
	const acct = await svc.account();
	const window = lastNDays(windowDays, todayIn(acct.reportingTimeZone, svc.now()));
	const baselineEnd = addDays(window.startDate, -1);
	const baseline = {
		startDate: addDays(baselineEnd, -(baselineDays - 1)),
		endDate: baselineEnd
	};
	const [{ current, previous }, apps] = await Promise.all([svc.rawReportWithPrevious("network", {
		dateRange: window,
		by: ["app"],
		metrics: [
			"earnings",
			"requests",
			"matched-requests",
			"impressions"
		],
		filters: opts.app ? { app: [opts.app] } : void 0
	}, { dateRange: baseline }), svc.apps()]);
	const currency = current.report.currency ?? acct.currencyCode;
	const now = sumByApp(current.report);
	const before = sumByApp(previous.report);
	const alias = new Map(apps.map((a) => [a.appId, a.alias]));
	const perDay = (micros, days) => Math.round(micros / days);
	const money = (micros) => `${formatMicros(micros)} ${currency}`;
	const findings = [];
	const judge = (app, appId, w, b) => {
		const earnings = perDay(w.earnings, windowDays);
		const baseEarnings = perDay(b.earnings, baselineDays);
		const row = {
			app,
			app_id: appId,
			status: "ok",
			earnings_per_day: microsToAmount(earnings),
			earnings_per_day_micros: earnings,
			baseline_earnings_per_day: microsToAmount(baseEarnings),
			baseline_earnings_per_day_micros: baseEarnings,
			requests: w.requests,
			baseline_requests: b.requests,
			match_rate: ratio(w.matched, w.requests),
			baseline_match_rate: ratio(b.matched, b.requests),
			show_rate: ratio(w.impressions, w.matched),
			baseline_show_rate: ratio(b.impressions, b.matched)
		};
		if (b.earnings > 0) row.earnings_change = (w.earnings / windowDays - b.earnings / baselineDays) / (b.earnings / baselineDays);
		if (b.requests < minRequests) {
			row.status = "thin";
			return row;
		}
		const breach = (metric, change, message) => {
			row.status = "breach";
			findings.push({
				app,
				metric,
				change,
				message
			});
		};
		if (w.requests === 0 && b.earnings === 0) breach("requests", -1, `${app} sent no ad requests in the window, after ${b.requests} in the baseline. Check that the app still loads ads (release, SDK, app-ads.txt, account status).`);
		if (row.earnings_change !== void 0 && row.earnings_change <= -drop) breach("earnings", row.earnings_change, w.requests === 0 ? `${app} sent no ad requests in the window; its baseline is ${money(baseEarnings)} per day. Check that the app still loads ads (release, SDK, app-ads.txt, account status).` : `${app} earned ${money(earnings)} per day, ${pct(-row.earnings_change)} below its ${money(baseEarnings)} baseline.`);
		const rate = (metric, name, value, base, denominator) => {
			if (denominator < minRequests / 10 || base <= 0) return;
			const change = (value - base) / base;
			if (change <= -drop) breach(metric, change, `${app}: ${name} fell to ${pct(value)} from ${pct(base)}.`);
		};
		rate("match_rate", "match rate", row.match_rate, row.baseline_match_rate, w.requests);
		rate("show_rate", "show rate", row.show_rate, row.baseline_show_rate, w.matched);
		return row;
	};
	const rows = [.../* @__PURE__ */ new Set([...before.keys(), ...now.keys()])].sort((a, b) => (before.get(b)?.earnings ?? 0) - (before.get(a)?.earnings ?? 0) || (now.get(b)?.earnings ?? 0) - (now.get(a)?.earnings ?? 0)).map((id) => judge(alias.get(id) ?? id, id, now.get(id) ?? ZERO, before.get(id) ?? ZERO));
	const result = {
		window: {
			from: formatDate(window.startDate),
			to: formatDate(window.endDate),
			days: windowDays
		},
		baseline: {
			from: formatDate(baseline.startDate),
			to: formatDate(baseline.endDate),
			days: baselineDays
		},
		thresholds: {
			drop,
			min_requests: minRequests
		},
		currency,
		timeZone: current.report.timeZone ?? acct.reportingTimeZone,
		estimate: true,
		breaches: 0,
		rows,
		findings,
		summary: [],
		notices: [...current.report.warnings.map((w) => `API warning: ${w}`), ...current.notices]
	};
	if (!opts.app) result.total = judge("(all apps)", "", [...now.values()].reduce(add, ZERO), [...before.values()].reduce(add, ZERO));
	result.breaches = findings.length;
	const thin = rows.filter((r) => r.status === "thin").length;
	if (thin) result.notices.push(`${thin} ${thin === 1 ? "app" : "apps"} had fewer than ${minRequests} requests in the baseline and ${thin === 1 ? "was" : "were"} not judged.`);
	const span = `${result.window.from}${windowDays > 1 ? ` → ${result.window.to}` : ""} against ${result.baseline.from} → ${result.baseline.to}`;
	result.summary = findings.length ? [
		`${findings.length} ${findings.length === 1 ? "drop" : "drops"} of ${pct(drop)} or more, ${span}.`,
		...findings.map((f) => f.message),
		ESTIMATE_LABEL
	] : [`No drop of ${pct(drop)} or more in earnings, match rate or show rate, ${span}.`, ESTIMATE_LABEL];
	return result;
}

//#endregion
export { CHECK_DEFAULTS, check };