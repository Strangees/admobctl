import { AdmobctlError, usageError } from "./errors.mjs";
import { buildAppIndex, resolveApp } from "./aliases.mjs";
import { configDir, loadConfig, resolveProfile } from "./config.mjs";
import { dateRangeFromArgs, formatDate, previousPeriod, splitRange, todayIn } from "./dates.mjs";
import { microsToAmount } from "./money.mjs";
import { resolveTokenProvider } from "./auth/index.mjs";
import { RATIO_BASES, mergeCampaignChunks } from "./campaign.mjs";
import { API_MAX_ROWS, MONEY_METRICS, TIME_DIMENSIONS, buildReportSpec, checkCombination, compatibleMetrics, friendlyMetric, friendlyName, normalizeDimension, normalizeMetric } from "./report.mjs";
import { AdmobClient } from "./client.mjs";
import { freshnessNotices } from "./freshness.mjs";
import { computeTotals, dimensionKey, metricKey, toViewRows } from "./report-view.mjs";

//#region src/core/service.ts
const DEFAULT_METRICS = {
	network: [
		"ESTIMATED_EARNINGS",
		"AD_REQUESTS",
		"MATCHED_REQUESTS",
		"IMPRESSIONS",
		"CLICKS",
		"MATCH_RATE",
		"SHOW_RATE",
		"IMPRESSION_CTR",
		"IMPRESSION_RPM"
	],
	mediation: [
		"ESTIMATED_EARNINGS",
		"AD_REQUESTS",
		"MATCHED_REQUESTS",
		"IMPRESSIONS",
		"CLICKS",
		"MATCH_RATE",
		"OBSERVED_ECPM"
	],
	campaign: [
		"IMPRESSIONS",
		"CLICKS",
		"CLICK_THROUGH_RATE",
		"INSTALLS",
		"ESTIMATED_COST",
		"AVERAGE_CPI"
	]
};
/** campaignReport:generate accepts at most 30 days per request. */
const CAMPAIGN_MAX_DAYS = 30;
/** Quote a value for the API's EBNF filter syntax. */
const filterValue = (v) => `"${v.replace(/["\\]/g, (c) => `\\${c}`)}"`;
const COMPARISONS = ["previous"];
/**
* The single core used by both the CLI and the MCP server.
* Everything user-facing is resolved here: profile, auth, account, aliases.
*/
var AdmobService = class AdmobService {
	profile;
	client;
	tokenProvider;
	accountOverride;
	now;
	configDir;
	fetch;
	/** In-flight or settled lookups (account, apps, ad units, ad sources), shared by every caller. */
	cache = /* @__PURE__ */ new Map();
	constructor(profile, client, tokenProvider, accountOverride, now, configDir, fetch) {
		this.profile = profile;
		this.client = client;
		this.tokenProvider = tokenProvider;
		this.accountOverride = accountOverride;
		this.now = now;
		this.configDir = configDir;
		this.fetch = fetch;
	}
	static create(opts = {}, deps = {}) {
		const dir = deps.configDir ?? configDir();
		const profile = resolveProfile(loadConfig(dir), opts.profile);
		const tokenProvider = deps.tokenProvider ?? resolveTokenProvider(profile, {
			configDir: dir,
			exec: deps.exec,
			fetch: deps.fetch
		});
		const client = new AdmobClient({
			getToken: () => tokenProvider.getToken(),
			quotaProject: profile.quotaProject ?? tokenProvider.quotaProject(),
			fetch: deps.fetch,
			sleep: deps.sleep
		});
		return new AdmobService(profile, client, tokenProvider, opts.account ?? profile.account, deps.now ?? (() => /* @__PURE__ */ new Date()), dir, deps.fetch ?? fetch);
	}
	/** The account that will be used (--account, then profile), without calling the API. Undefined means auto-detect. */
	get configuredAccount() {
		return this.accountOverride;
	}
	listAccounts() {
		return this.client.listAccounts();
	}
	/**
	* Memoize a lookup for the life of the service. A failure is forgotten, so the next call retries
	* (the service may be long-lived in the MCP server).
	*/
	memo(key, load) {
		const hit = this.cache.get(key);
		if (hit) return hit;
		const p = load();
		this.cache.set(key, p);
		p.catch(() => {
			if (this.cache.get(key) === p) this.cache.delete(key);
		});
		return p;
	}
	/** The active publisher account: --account, then profile, then the only accessible one. */
	account() {
		return this.memo("account", async () => {
			const accounts = await this.client.listAccounts();
			const ids = accounts.map((a) => a.publisherId).join(", ") || "(none)";
			const wanted = this.accountOverride?.replace(/^accounts\//, "");
			if (wanted) {
				const hit = accounts.find((a) => a.publisherId === wanted);
				if (!hit) throw new AdmobctlError("NOT_FOUND", `Account ${wanted} is not accessible. Accessible accounts: ${ids}`);
				return hit;
			}
			if (accounts.length === 1) return accounts[0];
			if (accounts.length === 0) throw new AdmobctlError("NOT_FOUND", "The signed-in Google user has no AdMob accounts.", { fix: "Sign in with the Google user that owns your AdMob account." });
			throw new AdmobctlError("USAGE", `Several AdMob accounts are accessible (${ids}). Pick one.`, { fix: "admobctl config set account <pub-…>  (or pass --account)" });
		});
	}
	apps() {
		return this.memo("apps", async () => buildAppIndex(await this.client.listApps((await this.account()).name), this.profile.aliases));
	}
	async resolveApp(input) {
		return resolveApp(input, await this.apps());
	}
	rawAdUnits() {
		return this.memo("adUnits", async () => this.client.listAdUnits((await this.account()).name));
	}
	async adUnits(opts = {}) {
		const [apps, units] = await Promise.all([this.apps(), this.rawAdUnits()]);
		const filterApp = opts.app ? resolveApp(opts.app, apps) : void 0;
		const aliasById = new Map(apps.map((a) => [a.appId, a.alias]));
		return units.filter((u) => !filterApp || u.appId === filterApp.appId).map((u) => ({
			name: u.displayName,
			adUnitId: u.adUnitId,
			app: aliasById.get(u.appId) ?? u.appId,
			appId: u.appId,
			format: u.adFormat,
			adTypes: u.adTypes ?? []
		}));
	}
	/** Resolve an ad unit by ad unit ID, its numeric fragment or its exact name. */
	async resolveAdUnit(input) {
		const q = input.trim();
		const units = await this.rawAdUnits();
		const exact = units.find((u) => u.adUnitId === q || u.name === q || u.adUnitId.endsWith(`/${q}`));
		if (exact) return exact;
		const byName = units.filter((u) => u.displayName.toLowerCase() === q.toLowerCase());
		if (byName.length === 1) return byName[0];
		if (byName.length > 1) throw usageError(`Ad unit name "${input}" is ambiguous: ${byName.map((u) => u.adUnitId).join(", ")}`);
		throw usageError(`Unknown ad unit "${input}". Run: admobctl ad-units list`);
	}
	adSources() {
		return this.memo("adSources", async () => this.client.listAdSources((await this.account()).name));
	}
	/** Resolve an ad source by ID or title (case-insensitive). */
	async resolveAdSource(input) {
		const q = input.trim().toLowerCase();
		const sources = await this.adSources();
		const hit = sources.find((s) => s.adSourceId === input.trim() || s.title.toLowerCase() === q);
		if (hit) return hit;
		throw usageError(`Unknown ad source "${input}". Ad sources: ${sources.map((s) => s.title).join(", ") || "(none)"}`);
	}
	async adapters(adSource) {
		const source = await this.resolveAdSource(adSource);
		return (await this.client.listAdapters((await this.account()).name, source.adSourceId)).map((a) => ({
			adapterId: a.adapterId,
			title: a.title,
			adSource: source.title,
			adSourceId: source.adSourceId,
			platform: a.platform,
			formats: a.formats ?? [],
			settings: (a.adapterConfigMetadata ?? []).map((m) => ({
				id: m.adapterConfigMetadataId,
				label: m.adapterConfigMetadataLabel,
				required: Boolean(m.isRequired)
			}))
		}));
	}
	/** Every mediation group as the API returns it (for export; the views below are for reading). */
	async rawMediationGroups() {
		return this.client.listMediationGroups((await this.account()).name);
	}
	async mediationGroups(f = {}) {
		const parts = [];
		if (f.app) parts.push(`CONTAINS_ANY(APP_IDS, ${filterValue((await this.resolveApp(f.app)).appId)})`);
		if (f.adSource) parts.push(`CONTAINS_ANY(AD_SOURCE_IDS, ${filterValue((await this.resolveAdSource(f.adSource)).adSourceId)})`);
		if (f.format) parts.push(`IN(FORMAT, ${filterValue(f.format.trim().toUpperCase().replace(/-/g, "_"))})`);
		if (f.platform) parts.push(`IN(PLATFORM, ${filterValue(f.platform.toUpperCase())})`);
		if (f.state) parts.push(`IN(STATE, ${filterValue(f.state.toUpperCase())})`);
		const acct = await this.account();
		const [groups, sources, units, apps] = await Promise.all([
			this.client.listMediationGroups(acct.name, parts.join(" AND ") || void 0),
			this.adSources().catch(() => []),
			this.rawAdUnits(),
			this.apps()
		]);
		const sourceTitle = new Map(sources.map((s) => [s.adSourceId, s.title]));
		const unitById = new Map(units.map((u) => [u.adUnitId, u]));
		const aliasById = new Map(apps.map((a) => [a.appId, a.alias]));
		const MODE_ORDER = {
			LIVE: 0,
			MANUAL: 1
		};
		return groups.map((g) => {
			const lines = Object.values(g.mediationGroupLines ?? {}).filter((l) => l.state !== "REMOVED").map((l) => {
				const line = {
					id: l.id,
					name: l.displayName ?? l.id,
					adSource: sourceTitle.get(l.adSourceId) ?? l.adSourceId,
					adSourceId: l.adSourceId,
					cpmMode: l.cpmMode ?? "",
					state: l.state ?? "",
					mappings: l.adUnitMappings ?? {}
				};
				if (l.cpmMode !== "LIVE" && l.cpmMicros !== void 0) {
					line.cpm_micros = Number(l.cpmMicros);
					line.cpm = line.cpm_micros / 1e6;
				}
				if (l.experimentVariant === "VARIANT_A") line.variant = "A";
				if (l.experimentVariant === "VARIANT_B") line.variant = "B";
				return line;
			}).sort((a, b) => (MODE_ORDER[a.cpmMode] ?? 2) - (MODE_ORDER[b.cpmMode] ?? 2) || (b.cpm_micros ?? 0) - (a.cpm_micros ?? 0));
			const t = g.targeting ?? {};
			const view = {
				id: g.mediationGroupId,
				name: g.displayName,
				state: g.state ?? "",
				platform: t.platform ?? "",
				format: t.format ?? "",
				adUnits: (t.adUnitIds ?? []).map((id) => {
					const u = unitById.get(id);
					return {
						adUnitId: id,
						name: u?.displayName ?? id,
						app: u ? aliasById.get(u.appId) ?? u.appId : ""
					};
				}),
				regions: t.targetedRegionCodes ?? [],
				excludedRegions: t.excludedRegionCodes ?? [],
				experiment: g.mediationAbExperimentState === "RUNNING" ? "running" : g.mediationAbExperimentState === "NOT_RUNNING" ? "none" : "unknown",
				lines,
				resource: g.name
			};
			if (t.idfaTargeting && t.idfaTargeting !== "IDFA_TARGETING_UNSPECIFIED") view.idfa = t.idfaTargeting;
			return view;
		});
	}
	/** One mediation group by ID or name (case-insensitive). */
	async mediationGroup(input) {
		const groups = await this.mediationGroups();
		const q = input.trim().toLowerCase();
		const hit = groups.find((g) => g.id === input.trim() || g.name.toLowerCase() === q);
		if (hit) return hit;
		throw usageError(`Unknown mediation group "${input}". Groups: ${groups.map((g) => g.name).join(", ") || "(none)"}`);
	}
	async adUnitMappings(adUnit) {
		const unit = await this.resolveAdUnit(adUnit);
		return (await this.client.listAdUnitMappings(unit.name)).map((m) => ({
			id: m.name.split("/").pop() ?? m.name,
			name: m.displayName ?? "",
			adUnit: unit.displayName,
			adUnitId: unit.adUnitId,
			adapterId: m.adapterId,
			state: m.state ?? "",
			settings: m.adUnitConfigurations ?? {},
			resource: m.name
		}));
	}
	/**
	* AdMob app-promotion campaign report (v1beta). The API takes at most 30 days per request, so longer
	* ranges are fetched in chunks and added up (or concatenated when the report is by date).
	*/
	async campaignReport(q) {
		const range = q.dateRange ?? dateRangeFromArgs(q.from ?? "", q.to ?? q.from ?? "");
		const dimensions = q.by.map((d) => normalizeDimension(d, "campaign"));
		const metrics = (q.metrics?.length ? q.metrics : DEFAULT_METRICS.campaign).map((m) => normalizeMetric(m, "campaign"));
		checkCombination(dimensions, metrics);
		const chunks = splitRange(range, 30);
		const merge = chunks.length > 1 && !dimensions.includes("DATE");
		const fetchMetrics = merge ? [.../* @__PURE__ */ new Set([...metrics, ...metrics.flatMap((m) => RATIO_BASES[m] ?? [])])] : metrics;
		const acct = await this.account();
		const reports = await Promise.all(chunks.map((dateRange) => this.client.campaignReport(acct.name, {
			dateRange,
			dimensions,
			metrics: fetchMetrics
		})));
		const report = merge ? mergeCampaignChunks(reports, dimensions) : {
			rows: reports.flatMap((r) => r.rows),
			warnings: reports.flatMap((r) => r.warnings)
		};
		const truncated = reports.some((r) => r.rows.length >= API_MAX_ROWS);
		const notices = ["Cost and CPI are in the campaigns' reporting currency. These are AdMob app-promotion campaigns, where you are the advertiser."];
		if (chunks.length > 1) notices.push(`Campaign reports cover at most ${30} days; fetched as ${chunks.length} requests of at most ${30} days.`);
		notices.push(...freshnessNotices("campaign", range, todayIn(acct.reportingTimeZone, this.now())));
		const result = {
			kind: "campaign",
			account: acct.publisherId,
			timeZone: acct.reportingTimeZone,
			from: formatDate(range.startDate),
			to: formatDate(range.endDate),
			dimensions: dimensions.map(dimensionKey),
			metrics: metrics.map(metricKey),
			rows: toViewRows(report, dimensions, metrics),
			truncated,
			warnings: report.warnings,
			notices
		};
		if (!truncated) result.totals = computeTotals(report, metrics);
		return result;
	}
	networkReport(q) {
		return this.report("network", q);
	}
	mediationReport(q) {
		return this.report("mediation", q);
	}
	/** Raw report access for finance/insights, which need exact micros per row. */
	async rawReport(kind, q) {
		const range = q.dateRange ?? dateRangeFromArgs(q.from ?? "", q.to ?? q.from ?? "");
		const dimensions = q.by.map((d) => normalizeDimension(d, kind));
		const notices = [];
		let metrics;
		if (q.metrics?.length) metrics = q.metrics.map((m) => normalizeMetric(m, kind));
		else {
			const { kept, dropped } = compatibleMetrics(kind, dimensions, DEFAULT_METRICS[kind]);
			metrics = kept;
			if (dropped.length) notices.push(`Left out ${dropped.map(friendlyMetric).join(", ")}: the AdMob API does not combine them with ${dimensions.map(friendlyName).join(", ")}.`);
		}
		const filters = await this.resolveFilters(kind, q.filters ?? {});
		const spec = buildReportSpec(kind, {
			dateRange: range,
			dimensions,
			metrics,
			filters,
			maxRows: q.maxRows,
			currency: q.currency,
			sort: q.sort
		});
		const acct = await this.account();
		const report = kind === "network" ? await this.client.networkReport(acct.name, spec) : await this.client.mediationReport(acct.name, spec);
		notices.push(...freshnessNotices(kind, range, todayIn(acct.reportingTimeZone, this.now())));
		return {
			report,
			dimensions,
			metrics,
			range,
			notices
		};
	}
	/**
	* A report and the same report for the equal-length period just before it, fetched together.
	* `previousQuery` overrides parts of the query for the earlier period (e.g. no row cap, or another range).
	*/
	async rawReportWithPrevious(kind, q, previousQuery = {}) {
		const range = q.dateRange ?? dateRangeFromArgs(q.from ?? "", q.to ?? q.from ?? "");
		const [current, previous] = await Promise.all([this.rawReport(kind, {
			...q,
			dateRange: range
		}), this.rawReport(kind, {
			...q,
			dateRange: previousPeriod(range),
			...previousQuery
		})]);
		return {
			current,
			previous
		};
	}
	async resolveFilters(kind, filters) {
		const out = {};
		for (const [dim, values] of Object.entries(filters)) {
			const api = normalizeDimension(dim, kind);
			out[api] = api === "APP" ? await Promise.all(values.map(async (v) => (await this.resolveApp(v)).appId)) : values;
		}
		return out;
	}
	async report(kind, q) {
		const cap = q.maxRows ?? 1e5;
		const probe = cap < API_MAX_ROWS;
		if (q.compare !== void 0 && !COMPARISONS.includes(q.compare)) throw usageError(`Unknown comparison "${q.compare}". Supported: ${COMPARISONS.join(", ")}`);
		if (q.compare && q.by.some((d) => TIME_DIMENSIONS.includes(normalizeDimension(d, kind)))) throw usageError("--compare does not work with date, week or month: the rows of two periods never line up. Drop the time dimension.");
		const currentQuery = probe ? {
			...q,
			maxRows: cap + 1
		} : q;
		const pair = q.compare ? await this.rawReportWithPrevious(kind, currentQuery, { maxRows: void 0 }) : void 0;
		const { report, dimensions, metrics, range, notices } = pair?.current ?? await this.rawReport(kind, currentQuery);
		const apps = dimensions.includes("APP") ? await this.apps() : [];
		const fetched = report.rows.length;
		const truncated = probe ? fetched > cap : fetched >= cap && (report.matchingRowCount === void 0 || report.matchingRowCount > fetched);
		if (truncated && report.matchingRowCount !== void 0 && report.matchingRowCount <= fetched) report.matchingRowCount = void 0;
		if (fetched > cap) report.rows = report.rows.slice(0, cap);
		const acct = await this.account();
		const result = {
			kind,
			account: acct.publisherId,
			currency: report.currency ?? acct.currencyCode,
			timeZone: report.timeZone ?? acct.reportingTimeZone,
			from: formatDate(range.startDate),
			to: formatDate(range.endDate),
			dimensions: dimensions.map(dimensionKey),
			metrics: metrics.map(metricKey),
			rows: toViewRows(report, dimensions, metrics, apps),
			truncated,
			warnings: report.warnings,
			notices
		};
		if (!truncated) result.totals = computeTotals(report, metrics);
		if (report.matchingRowCount !== void 0) result.matchingRowCount = report.matchingRowCount;
		if (pair) addComparison(result, report, pair.previous, dimensions, metrics);
		return result;
	}
};
const change = (cur, prev) => prev > 0 ? (cur - prev) / prev : void 0;
/** Join the previous period onto the rows (and totals) of `result`: `previous_<metric>` and `<metric>_change`. */
function addComparison(result, report, previous, dimensions, metrics) {
	const keyOf = (row) => dimensions.map((d) => row.dimensions[d]?.value ?? "").join("\0");
	const before = new Map(previous.report.rows.map((row) => [keyOf(row), row]));
	const seen = /* @__PURE__ */ new Set();
	report.rows.forEach((row, i) => {
		const key = keyOf(row);
		const prev = before.get(key);
		const out = result.rows[i];
		if (!prev || !out) return;
		seen.add(key);
		for (const m of metrics) {
			const k = metricKey(m);
			const was = prev.metrics[m] ?? 0;
			if (MONEY_METRICS.has(m)) {
				out[`previous_${k}`] = microsToAmount(was);
				out[`previous_${k}_micros`] = was;
			} else out[`previous_${k}`] = was;
			const c = change(row.metrics[m] ?? 0, was);
			if (c !== void 0) out[`${k}_change`] = c;
		}
	});
	result.previous = {
		from: formatDate(previous.range.startDate),
		to: formatDate(previous.range.endDate)
	};
	if (result.totals) {
		const totals = computeTotals(previous.report, metrics);
		result.previous.totals = totals;
		for (const k of Object.keys(result.totals).filter((k) => !k.endsWith("_micros"))) {
			const exact = (t) => Number(t[`${k}_micros`] ?? t[k] ?? 0);
			const c = change(exact(result.totals), exact(totals));
			if (c !== void 0) result.totals[`${k}_change`] = c;
		}
		const gone = previous.report.rows.filter((row) => !seen.has(keyOf(row))).length;
		if (gone) result.notices.push(`${gone} ${gone === 1 ? "row" : "rows"} existed only in the previous period (${result.previous.from} → ${result.previous.to}) and ${gone === 1 ? "is" : "are"} not listed.`);
	}
}

//#endregion
export { AdmobService, COMPARISONS, DEFAULT_METRICS };