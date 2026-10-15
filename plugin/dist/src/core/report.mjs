import { usageError } from "./errors.mjs";
import { parseMicros } from "./money.mjs";

//#region src/core/report.ts
const DIMENSIONS = {
	network: [
		"DATE",
		"MONTH",
		"WEEK",
		"AD_UNIT",
		"APP",
		"AD_TYPE",
		"COUNTRY",
		"FORMAT",
		"PLATFORM",
		"MOBILE_OS_VERSION",
		"GMA_SDK_VERSION",
		"APP_VERSION_NAME",
		"SERVING_RESTRICTION"
	],
	mediation: [
		"DATE",
		"MONTH",
		"WEEK",
		"AD_SOURCE",
		"AD_SOURCE_INSTANCE",
		"AD_UNIT",
		"APP",
		"MEDIATION_GROUP",
		"COUNTRY",
		"FORMAT",
		"PLATFORM",
		"MOBILE_OS_VERSION",
		"GMA_SDK_VERSION",
		"APP_VERSION_NAME",
		"SERVING_RESTRICTION"
	],
	campaign: [
		"DATE",
		"CAMPAIGN_ID",
		"CAMPAIGN_NAME",
		"AD_ID",
		"AD_NAME",
		"PLACEMENT_ID",
		"PLACEMENT_NAME",
		"PLACEMENT_PLATFORM",
		"COUNTRY",
		"FORMAT"
	]
};
const METRICS = {
	network: [
		"AD_REQUESTS",
		"CLICKS",
		"ESTIMATED_EARNINGS",
		"IMPRESSIONS",
		"IMPRESSION_CTR",
		"IMPRESSION_RPM",
		"MATCHED_REQUESTS",
		"MATCH_RATE",
		"SHOW_RATE"
	],
	mediation: [
		"AD_REQUESTS",
		"CLICKS",
		"ESTIMATED_EARNINGS",
		"IMPRESSIONS",
		"IMPRESSION_CTR",
		"MATCHED_REQUESTS",
		"MATCH_RATE",
		"OBSERVED_ECPM"
	],
	campaign: [
		"IMPRESSIONS",
		"CLICKS",
		"CLICK_THROUGH_RATE",
		"INSTALLS",
		"ESTIMATED_COST",
		"AVERAGE_CPI",
		"INTERACTIONS"
	]
};
/** Metrics the API returns as `microsValue` (money). */
const MONEY_METRICS = /* @__PURE__ */ new Set([
	"ESTIMATED_EARNINGS",
	"IMPRESSION_RPM",
	"OBSERVED_ECPM",
	"ESTIMATED_COST",
	"AVERAGE_CPI"
]);
const METRIC_ALIASES = {
	EARNINGS: "ESTIMATED_EARNINGS",
	REVENUE: "ESTIMATED_EARNINGS",
	REQUESTS: "AD_REQUESTS",
	MATCHED: "MATCHED_REQUESTS",
	CTR: "IMPRESSION_CTR",
	RPM: "IMPRESSION_RPM",
	ECPM: "OBSERVED_ECPM",
	COST: "ESTIMATED_COST",
	CPI: "AVERAGE_CPI"
};
/** Aliases that mean something else in one report type. */
const KIND_METRIC_ALIASES = { campaign: { CTR: "CLICK_THROUGH_RATE" } };
const DIMENSION_ALIASES = {
	UNIT: "AD_UNIT",
	SOURCE: "AD_SOURCE",
	OS_VERSION: "MOBILE_OS_VERSION",
	SDK_VERSION: "GMA_SDK_VERSION",
	APP_VERSION: "APP_VERSION_NAME",
	CAMPAIGN: "CAMPAIGN_NAME",
	AD: "AD_NAME",
	PLACEMENT: "PLACEMENT_NAME"
};
function canonical(name) {
	return name.trim().toUpperCase().replace(/-/g, "_");
}
function friendlyName(apiName) {
	return apiName.toLowerCase().replace(/_/g, "-");
}
/** The short name users type for an API metric, e.g. AD_REQUESTS → requests. */
function friendlyMetric(apiName) {
	return friendlyName(Object.keys(METRIC_ALIASES).find((k) => METRIC_ALIASES[k] === apiName) ?? apiName);
}
function normalizeDimension(name, kind) {
	const c = canonical(name);
	const resolved = DIMENSION_ALIASES[c] ?? c;
	if (!DIMENSIONS[kind].includes(resolved)) throw usageError(`Dimension "${name}" is not supported by ${kind} reports. Valid: ${DIMENSIONS[kind].map(friendlyName).join(", ")}`);
	return resolved;
}
function normalizeMetric(name, kind) {
	const c = canonical(name);
	const resolved = KIND_METRIC_ALIASES[kind]?.[c] ?? METRIC_ALIASES[c] ?? c;
	if (!METRICS[kind].includes(resolved)) throw usageError(`Metric "${name}" is not supported by ${kind} reports. Valid: ${METRICS[kind].map(friendlyName).join(", ")}`);
	return resolved;
}
/** The API's own maximum for maxReportRows. */
const API_MAX_ROWS = 1e5;
const TIME_DIMENSIONS = [
	"DATE",
	"WEEK",
	"MONTH"
];
/** Combinations the API rejects (both the reference and the metrics guide agree). */
const INCOMPATIBLE = { AD_TYPE: [
	"AD_REQUESTS",
	"MATCH_RATE",
	"IMPRESSION_RPM"
] };
/**
* Combinations the 2025 metrics guide calls incompatible but the newer reference no longer mentions.
* We leave these out of default metrics but still send them when asked for explicitly.
*/
const DISCOURAGED = {
	MOBILE_OS_VERSION: [
		"ESTIMATED_EARNINGS",
		"OBSERVED_ECPM",
		"IMPRESSION_RPM"
	],
	GMA_SDK_VERSION: [
		"ESTIMATED_EARNINGS",
		"OBSERVED_ECPM",
		"IMPRESSION_RPM"
	],
	APP_VERSION_NAME: [
		"ESTIMATED_EARNINGS",
		"OBSERVED_ECPM",
		"IMPRESSION_RPM"
	]
};
/** Split (API-named) default metrics into those that work with the dimensions and those to leave out. */
function compatibleMetrics(_kind, dimensions, metrics) {
	const excluded = new Set(dimensions.flatMap((d) => [...INCOMPATIBLE[d] ?? [], ...DISCOURAGED[d] ?? []]));
	return {
		kept: metrics.filter((m) => !excluded.has(m)),
		dropped: metrics.filter((m) => excluded.has(m))
	};
}
function checkCombination(dimensions, metrics) {
	const timeDims = dimensions.filter((d) => TIME_DIMENSIONS.includes(d));
	if (timeDims.length > 1) throw usageError(`A report can use only one time dimension (date, week or month), got ${timeDims.map(friendlyName).join(", ")}.`);
	for (const d of dimensions) {
		const bad = metrics.filter((m) => INCOMPATIBLE[d]?.includes(m));
		if (bad.length) throw usageError(`${friendlyName(d)} cannot be combined with ${bad.map(friendlyMetric).join(", ")} (an AdMob API restriction). Drop one of them.`);
	}
}
function normalizeCurrency(code) {
	const c = code.trim().toUpperCase();
	if (!/^[A-Z]{3}$/.test(c)) throw usageError(`Currency must be an ISO 4217 code like USD or EUR, got "${code}"`);
	return c;
}
/**
* `--sort <field>[:asc|desc]`. The field is one of the report's own (API-named) dimensions or metrics;
* dimensions ascend and metrics descend unless an order is given.
*/
function parseSort(input, kind, dimensions, metrics) {
	const [field = "", dir, ...rest] = input.split(":").map((p) => p.trim());
	const order = dir?.toLowerCase();
	if (rest.length || order !== void 0 && order !== "asc" && order !== "desc") throw usageError(`--sort expects <field>[:asc|desc] with asc or desc, got "${input}"`);
	const named = (resolve) => {
		try {
			return resolve();
		} catch {
			return;
		}
	};
	const dimension = named(() => normalizeDimension(field, kind));
	if (dimension && dimensions.includes(dimension)) return {
		dimension,
		order: order === "desc" ? "DESCENDING" : "ASCENDING"
	};
	const metric = named(() => normalizeMetric(field, kind));
	if (metric && metrics.includes(metric)) return {
		metric,
		order: order === "asc" ? "ASCENDING" : "DESCENDING"
	};
	throw usageError(`Cannot sort by "${field}": it is not in this report. Sort by one of: ${[...dimensions.map(friendlyName), ...metrics.map(friendlyMetric)].join(", ")}`);
}
function buildReportSpec(kind, input) {
	const dimensions = input.dimensions.map((d) => normalizeDimension(d, kind));
	const metrics = input.metrics.map((m) => normalizeMetric(m, kind));
	checkCombination(dimensions, metrics);
	const spec = {
		dateRange: input.dateRange,
		dimensions,
		metrics
	};
	const filters = Object.entries(input.filters ?? {});
	if (filters.length) spec.dimensionFilters = filters.map(([dim, values]) => ({
		dimension: normalizeDimension(dim, kind),
		matchesAny: { values }
	}));
	const timeDim = dimensions.find((d) => TIME_DIMENSIONS.includes(d));
	if (input.sort !== void 0) spec.sortConditions = [parseSort(input.sort, kind, dimensions, metrics)];
	else if (timeDim) spec.sortConditions = [{
		dimension: timeDim,
		order: "ASCENDING"
	}];
	else if (metrics.includes("ESTIMATED_EARNINGS")) spec.sortConditions = [{
		metric: "ESTIMATED_EARNINGS",
		order: "DESCENDING"
	}];
	if (input.currency !== void 0) spec.localizationSettings = { currencyCode: normalizeCurrency(input.currency) };
	if (input.maxRows !== void 0) spec.maxReportRows = input.maxRows;
	return spec;
}
function metricNumber(key, v) {
	if (v.microsValue !== void 0) return parseMicros(v.microsValue);
	if (v.integerValue !== void 0) return Number(v.integerValue);
	if (MONEY_METRICS.has(key) && v.doubleValue !== void 0) return Math.round(v.doubleValue * 1e6);
	return v.doubleValue ?? 0;
}
/**
* Parse a report response: the streamed JSON array of networkReport/mediationReport:generate
* (header, rows, footer), or campaignReport:generate's single `{ rows: [...] }` object.
*/
function parseReport(raw) {
	const rows = raw?.rows;
	const chunks = Array.isArray(raw) ? raw : Array.isArray(rows) ? rows.map((row) => ({ row })) : [raw];
	const report = {
		rows: [],
		warnings: []
	};
	for (const chunk of chunks) {
		if (chunk.header) {
			report.currency = chunk.header.localizationSettings?.currencyCode;
			report.timeZone = chunk.header.reportingTimeZone;
			report.dateRange = chunk.header.dateRange;
		}
		if (chunk.row) {
			const dimensions = {};
			for (const [k, v] of Object.entries(chunk.row.dimensionValues ?? {})) dimensions[k] = v.displayLabel === void 0 ? { value: v.value ?? "" } : {
				value: v.value ?? "",
				label: v.displayLabel
			};
			const metrics = {};
			for (const [k, v] of Object.entries(chunk.row.metricValues ?? {})) metrics[k] = metricNumber(k, v);
			report.rows.push({
				dimensions,
				metrics
			});
		}
		if (chunk.footer) {
			if (chunk.footer.matchingRowCount !== void 0) report.matchingRowCount = Number(chunk.footer.matchingRowCount);
			for (const w of chunk.footer.warnings ?? []) report.warnings.push(w.description ?? w.type ?? "unknown warning");
		}
	}
	return report;
}

//#endregion
export { API_MAX_ROWS, DIMENSIONS, METRICS, MONEY_METRICS, TIME_DIMENSIONS, buildReportSpec, checkCombination, compatibleMetrics, friendlyMetric, friendlyName, normalizeCurrency, normalizeDimension, normalizeMetric, parseReport, parseSort };