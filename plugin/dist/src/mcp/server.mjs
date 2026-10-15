import { AdmobctlError } from "../core/errors.mjs";
import { log } from "../core/log.mjs";
import { setupStatus } from "../core/setup/status.mjs";
import { JOURNAL_COLUMNS, financeForecast, financeMonth, financeRange, journalRows } from "../core/finance.mjs";
import { INSIGHT_DIMENSIONS, insights } from "../core/insights.mjs";
import { VERSION_KINDS, analyzeConsent, analyzeVersions, analyzeWaterfall } from "../core/analyze.mjs";
import { checkAppAds } from "../core/app-ads.mjs";
import { check } from "../core/check.mjs";
import { financeBalance } from "../core/payments.mjs";
import { VERSION } from "../version.mjs";
import { exportJournal } from "../core/journal.mjs";
import { analyzeGeo } from "../core/geo.mjs";
import { lint } from "../core/lint.mjs";
import { shownRows } from "../core/report-view.mjs";
import { COMPARISONS } from "../core/service.mjs";
import { renderTsv } from "../output/format.mjs";
import { TREND_SPLITS, analyzeTrend } from "../core/trend.mjs";
import { array, boolean, enum as _enum, literal, looseObject, number, record, string, unknown } from "../../vendor/zod/v4/classic/schemas.mjs";
import { McpServer } from "../../vendor/@modelcontextprotocol/sdk/dist/esm/server/mcp.mjs";
import { StdioServerTransport } from "../../vendor/@modelcontextprotocol/sdk/dist/esm/server/stdio.mjs";

//#region src/mcp/server.ts
/** ~25k tokens of JSON. Results above this are trimmed with a notice. */
const MAX_TEXT_CHARS = 6e4;
const DEFAULT_MAX_ROWS = 200;
const HARD_MAX_ROWS = 5e3;
/** How long one AdmobService (and its cached account, apps index and token) is reused across tool calls. */
const SERVICE_TTL_MS = 3e5;
const INSTRUCTIONS = `Read-only access to the user's Google AdMob account via admobctl.
- Apps are referred to by alias (e.g. "my-game-ios"); call admobctl_list_apps to see them.
- All earnings are ESTIMATES. When reporting money, say so and that they should be reconciled against AdMob Payments (finalized).
- For "is everything OK?" or "did revenue drop?" use admobctl_check: it compares the last complete day with the week before.
- For "what did I earn in <month>" use admobctl_finance_month; for trends and recommendations use admobctl_insights.
- For "what is my balance / what will Google pay me" use admobctl_finance_balance (unpaid balance; it needs an extra scope, so pass its Fix line on if it fails).
- For a file an accounting system can import, use admobctl_finance_export and hand over its \`content\` unchanged.
- For SDK/app-version problems, consent impact or mediation waterfalls use the admobctl_analyze_* tools.
- For "is my app-ads.txt OK?" or unexplained "limited ad serving" use admobctl_check_app_ads. Google Play listings cannot be
  read, so Android apps show unknown-website until their developer website is added by hand. Never guess a website: ask the
  user for it and pass it as \`website\`, or have them save it once with: admobctl config set websites.<alias> <url>
- Ad sources, adapters, mediation groups, ad unit mappings and campaign reports use AdMob API v1beta. Google limits some of
  these to allowlisted accounts; a "v1beta" permission error is not a setup mistake, so pass its Fix line on and move on.
- These tools never change anything. Changes (creating apps, ad units or mappings; editing mediation groups; A/B
  experiments) exist only as admobctl CLI commands, which print a plan and send nothing unless the user adds --yes.
- Errors include a "Fix:" line with the exact command the user should run.
- For any sign-in, scope, quota project or API error, call admobctl_setup_status and run its next_command (an admobctl
  command) in the terminal exactly as given. Never improvise gcloud commands. Commands with --yes change the user's setup:
  show them first. The browser sign-in (admobctl setup login --yes) must run in the user's own terminal.
  If a service-account credential override prevents sign-in, pass on the full manual fix; the user must unset
  GOOGLE_APPLICATION_CREDENTIALS in their terminal before login. Do not repeatedly run login while it is set.`;
const annotations = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: true
};
const appArg = { app: string().optional().describe("Only this app (alias, app ID or name)") };
const accountArg = { account: string().optional().describe("Publisher ID (pub-…). Defaults to the configured or only account.") };
const currencyArg = { currency: string().regex(/^[A-Za-z]{3}$/, "an ISO 4217 code like USD").optional().describe("ISO 4217 code to convert earnings into, e.g. USD. Default: the account currency.") };
const anyRecord = record(string(), unknown());
const loose = (shape) => looseObject(shape);
function textOf(data) {
	return JSON.stringify(data);
}
function ok(data) {
	return {
		content: [{
			type: "text",
			text: textOf(data)
		}],
		structuredContent: data
	};
}
function fail(err) {
	const text = err instanceof AdmobctlError ? `${err.message}${err.fix ? `\nFix: ${err.fix}` : ""}` : `Unexpected error: ${err?.message ?? String(err)}`;
	if (!(err instanceof AdmobctlError)) log.warn(err?.stack ?? String(err));
	return {
		content: [{
			type: "text",
			text
		}],
		isError: true
	};
}
/** Per-country totals the geo tool returns; the rows still cover every country. */
const GEO_MAX_COUNTRIES = 25;
/** Drop trailing rows until the JSON fits the context budget. */
function fitRows(result) {
	if (textOf(result).length <= 6e4) return result;
	const all = result.rows;
	let lo = 0;
	let hi = all.length;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (textOf({
			...result,
			rows: all.slice(0, mid),
			truncated: true,
			notice: "x".repeat(200)
		}).length <= 6e4) lo = mid;
		else hi = mid - 1;
	}
	return {
		...result,
		rows: all.slice(0, lo),
		truncated: true,
		notice: `Showing ${lo} of ${all.length} returned rows to stay within the context limit. Narrow the query (fewer dimensions, a filter, or a shorter range) to see the rest.`
	};
}
function reportPayload(r) {
	const payload = { ...r };
	if (r.truncated) payload.notice = `Truncated: ${shownRows(r)}. Raise max_rows (≤ ${HARD_MAX_ROWS}) or narrow the query.`;
	return fitRows(payload);
}
const reportInput = {
	from: string().describe("Start date, YYYY-MM (whole month) or YYYY-MM-DD"),
	to: string().optional().describe("End date, YYYY-MM or YYYY-MM-DD. Defaults to `from`."),
	by: array(string()).optional().describe("Dimensions, e.g. [\"app\"], [\"ad-unit\",\"country\"], [\"date\"]. Default [\"app\"]."),
	metrics: array(string()).optional().describe("Metrics, e.g. [\"earnings\",\"impressions\",\"match-rate\",\"show-rate\",\"rpm\"]. Default: all common metrics."),
	filters: record(string(), array(string())).optional().describe("Dimension filters, e.g. {\"country\":[\"NO\",\"SE\"],\"app\":[\"my-game-ios\"]}. App filters accept aliases."),
	max_rows: number().int().positive().max(HARD_MAX_ROWS).optional().describe(`Row cap (default ${200}).`),
	sort: string().optional().describe("Sort by a dimension or metric of the report, e.g. \"impressions\", \"match-rate:asc\", \"country\". Default: by time, else by earnings."),
	compare: _enum(COMPARISONS).optional().describe("previous: add previous_<metric> and <metric>_change (a fraction) to each row and the totals, against the equal-length period just before. Not with date, week or month."),
	...currencyArg,
	...accountArg
};
const reportOutput = loose({
	kind: string(),
	from: string(),
	to: string(),
	currency: string().optional(),
	rows: array(anyRecord),
	totals: anyRecord.optional(),
	truncated: boolean(),
	previous: anyRecord.optional(),
	notice: string().optional(),
	notices: array(string())
});
function createMcpServer(deps) {
	const server = new McpServer({
		name: "admobctl",
		version: VERSION
	}, { instructions: INSTRUCTIONS });
	const ttl = deps.serviceTtlMs ?? 3e5;
	const now = deps.now ?? Date.now;
	const services = /* @__PURE__ */ new Map();
	const freshSvc = (a) => {
		const fresh = deps.service({ account: a.account });
		services.set(a.account ?? "", {
			svc: fresh,
			createdAt: now()
		});
		return fresh;
	};
	const svc = (a) => {
		const hit = services.get(a.account ?? "");
		if (hit && now() - hit.createdAt < ttl) return hit.svc;
		return freshSvc(a);
	};
	const wrap = (fn) => async (args) => {
		try {
			return ok(await fn(args));
		} catch (err) {
			return fail(err);
		}
	};
	server.registerTool("admobctl_list_accounts", {
		title: "List AdMob accounts",
		description: "List the AdMob publisher accounts the signed-in user can access (publisher ID, currency, reporting time zone).",
		inputSchema: {},
		outputSchema: loose({ accounts: array(anyRecord) }),
		annotations
	}, wrap(async () => ({ accounts: await svc({}).listAccounts() })));
	server.registerTool("admobctl_list_apps", {
		title: "List AdMob apps",
		description: "List apps in the AdMob account with their aliases (use the alias in other tools), platform, app ID, store ID and approval state (ACTION_REQUIRED means the app needs the publisher's attention in AdMob review; ad serving may be limited).",
		inputSchema: { ...accountArg },
		outputSchema: loose({ apps: array(anyRecord) }),
		annotations
	}, wrap(async (a) => ({ apps: await svc(a).apps() })));
	server.registerTool("admobctl_check_app_ads", {
		title: "Check app-ads.txt",
		description: "Check each app's app-ads.txt the way AdMob's crawler does: the developer website from the App Store listing (Google Play listings cannot be read, so Android apps need `website` from the user or one saved with `admobctl config set websites.<alias> <url>`; do not guess it), https then http, and a google.com line with the publisher ID marked DIRECT. Per app: ok, missing-file, html (a web page instead of the file), no-line, reseller-only, unreachable, no-website, unknown-website or not-linked, plus the exact line to add. Fetches the store lookup and the developer websites, not just the AdMob API.",
		inputSchema: {
			...appArg,
			website: string().optional().describe("Developer website for apps whose store listing cannot be read (Android), e.g. example.com"),
			...accountArg
		},
		outputSchema: loose({
			publisherId: string(),
			expectedLine: string(),
			problems: number(),
			apps: array(anyRecord),
			summary: array(string())
		}),
		annotations
	}, wrap(async (a) => await checkAppAds(svc(a), {
		app: a.app,
		website: a.website
	})));
	server.registerTool("admobctl_list_ad_units", {
		title: "List AdMob ad units",
		description: "List ad units (name, format, ad unit ID) for all apps or one app.",
		inputSchema: {
			app: string().optional().describe("App alias, app ID or name"),
			...accountArg
		},
		outputSchema: loose({ adUnits: array(anyRecord) }),
		annotations
	}, wrap(async (a) => ({ adUnits: await svc(a).adUnits({ app: a.app }) })));
	for (const kind of ["network", "mediation"]) server.registerTool(`admobctl_${kind}_report`, {
		title: `AdMob ${kind} report`,
		description: kind === "network" ? "AdMob Network report: estimated earnings, requests, match rate, impressions, show rate, CTR and RPM by any dimension (app, ad-unit, country, format, platform, date, month…)." : "Mediation report across ad sources: earnings, requests, match rate, impressions, observed eCPM by ad-source, app, ad-unit, country…",
		inputSchema: reportInput,
		outputSchema: reportOutput,
		annotations
	}, wrap(async (a) => {
		const s = svc(a);
		const q = {
			from: a.from,
			to: a.to ?? a.from,
			by: a.by?.length ? a.by : ["app"],
			metrics: a.metrics,
			filters: a.filters,
			maxRows: a.max_rows ?? 200,
			currency: a.currency,
			sort: a.sort,
			compare: a.compare
		};
		return reportPayload(kind === "network" ? await s.networkReport(q) : await s.mediationReport(q));
	}));
	server.registerTool("admobctl_finance_month", {
		title: "AdMob earnings for a month",
		description: "Estimated AdMob earnings for one calendar month, per app and in total, for bookkeeping. With include_journal, also returns Bilagsjournal rows (debit receivable, credit revenue per app, dated at month-end) and journal_tsv, a paste-ready tab-separated block to show verbatim. Figures are estimates, not finalized payments.",
		inputSchema: {
			month: string().describe("YYYY-MM"),
			include_journal: boolean().optional().describe("Also return journal rows"),
			...accountArg
		},
		outputSchema: loose({
			month: string(),
			currency: string(),
			complete: boolean(),
			estimate: literal(true),
			total: number(),
			apps: array(anyRecord),
			notes: array(string()),
			journal: array(anyRecord).optional(),
			journal_tsv: string().optional()
		}),
		annotations
	}, wrap(async (a) => {
		const s = svc(a);
		const m = await financeMonth(s, a.month);
		if (!a.include_journal) return { ...m };
		const journal = journalRows(m, s.profile.finance);
		const journal_tsv = renderTsv({
			columns: JOURNAL_COLUMNS.map((c) => ({
				key: c,
				label: c
			})),
			rows: journal
		});
		return {
			...m,
			journal,
			journal_tsv
		};
	}));
	server.registerTool("admobctl_finance_range", {
		title: "AdMob earnings per month over a range",
		description: "Estimated AdMob earnings per month (and per app within each month) for a range of months, with a grand total. Estimates, not finalized payments.",
		inputSchema: {
			from: string().describe("First month, YYYY-MM"),
			to: string().describe("Last month, YYYY-MM"),
			...accountArg
		},
		outputSchema: loose({
			from: string(),
			to: string(),
			currency: string(),
			estimate: literal(true),
			total: number(),
			months: array(anyRecord),
			notes: array(string())
		}),
		annotations
	}, wrap(async (a) => ({ ...await financeRange(svc(a), a.from, a.to) })));
	server.registerTool("admobctl_finance_forecast", {
		title: "AdMob month-end projection",
		description: "Month-to-date estimated earnings per app and a month-end projection: the daily average of the month's complete days carried to the end of the month. Defaults to the current month. A projection of estimates, for pacing only: never book it or present it as earnings. For a month that has ended it returns that month's estimate (projection=false).",
		inputSchema: {
			month: string().optional().describe("YYYY-MM. Default: the current month."),
			...accountArg
		},
		outputSchema: loose({
			month: string(),
			currency: string(),
			complete: boolean(),
			estimate: literal(true),
			projection: boolean(),
			days_elapsed: number(),
			days_in_month: number(),
			month_to_date: number(),
			projected: number(),
			apps: array(anyRecord),
			notes: array(string())
		}),
		annotations
	}, wrap(async (a) => ({ ...await financeForecast(svc(a), a.month) })));
	server.registerTool("admobctl_setup_status", {
		title: "admobctl setup status",
		description: "Checks the admobctl setup (credentials, scopes per feature, quota project, enabled APIs, AdMob account, app review, v1beta access). Each failing check has fix_command, a runnable admobctl command; next_command is the one to run first. Read-only: run the commands in the CLI.",
		inputSchema: { ...accountArg },
		outputSchema: loose({
			ok: boolean(),
			checks: array(anyRecord),
			next_command: string().optional()
		}),
		annotations
	}, wrap(async (a) => {
		const s = freshSvc(a);
		return { ...await setupStatus(s, { fetch: s.fetch }) };
	}));
	server.registerTool("admobctl_finance_balance", {
		title: "AdMob unpaid balance",
		description: "Current unpaid balance Google will pay out (AdSense Management API; includes AdMob earnings), in the account's payment currency. Not a monthly figure and not payment history. Needs a one-time extra sign-in scope; if it fails, pass the Fix line on.",
		inputSchema: { ...accountArg },
		outputSchema: loose({
			account: string(),
			currency: string(),
			unpaid: number(),
			notes: array(string())
		}),
		annotations
	}, wrap(async (a) => ({ ...await financeBalance(svc(a)) })));
	server.registerTool("admobctl_finance_export", {
		title: "Export AdMob accruals as Revenue Journal",
		description: "Accrual vouchers for one month or a range of months in the Revenue Journal format (an open format for platform revenue bookkeeping): one balanced voucher per month, debit the receivable, credit revenue per app. Returns `content`, the complete file as text (JSON document or CSV), to save or pass to an accounting import verbatim. Give either `month` or both `from` and `to`. Figures are estimates, not finalized payments.",
		inputSchema: {
			month: string().optional().describe("One month, YYYY-MM"),
			from: string().optional().describe("First month of a range, YYYY-MM (with `to`, instead of `month`)"),
			to: string().optional().describe("Last month of a range, YYYY-MM"),
			as: _enum(["json", "csv"]).optional().describe("File format: json (default) or csv"),
			integer_amounts: boolean().optional().describe("JSON only: write amounts as integers instead of decimal strings"),
			scale: number().int().min(0).max(6).optional().describe("Decimal places the integers carry (default 2; 6 = micros). Needs integer_amounts."),
			...accountArg
		},
		outputSchema: loose({
			as: string(),
			content: string(),
			notes: array(string())
		}),
		annotations
	}, wrap(async (a) => {
		const as = `revenue-journal-${a.as ?? "json"}`;
		return {
			as,
			...await exportJournal(svc(a), {
				as,
				month: a.month,
				from: a.from,
				to: a.to,
				integerAmounts: a.integer_amounts,
				scale: a.scale
			})
		};
	}));
	server.registerTool("admobctl_insights", {
		title: "AdMob monetization insights",
		description: "Analyze monetization: earnings, eCPM, request RPM, match (fill) rate, show rate and CTR per app/ad-unit/country/format/platform, compared with the previous period. Returns highlights (top and bottom earners, low fill, low show rate, big swings) and a plain-language summary with the numbers behind each claim.",
		inputSchema: {
			last_days: number().int().min(1).max(366).optional().describe("The last N complete days (default 30)"),
			from: string().optional().describe("Start, YYYY-MM or YYYY-MM-DD (instead of last_days)"),
			to: string().optional().describe("End, YYYY-MM or YYYY-MM-DD"),
			by: _enum(INSIGHT_DIMENSIONS).optional().describe("Group by (default ad-unit)"),
			...currencyArg,
			...accountArg
		},
		outputSchema: loose({
			from: string(),
			to: string(),
			currency: string(),
			estimate: literal(true),
			totals: anyRecord,
			rows: array(anyRecord),
			highlights: array(anyRecord),
			summary: array(string())
		}),
		annotations
	}, wrap(async (a) => {
		return fitRows({ ...await insights(svc(a), {
			last: a.last_days,
			from: a.from,
			to: a.to,
			by: a.by ?? "ad-unit",
			currency: a.currency
		}) });
	}));
	server.registerTool("admobctl_check", {
		title: "AdMob health check",
		description: "Did anything break? Compares the last complete day(s) with the days just before, per app and in total, and reports `findings` where daily earnings, match rate or show rate dropped by the threshold or more, or an app stopped sending ad requests (`breaches` is their count; 0 means nothing dropped). Rows with status `thin` had too little baseline traffic to judge: do not report them as problems. Use for \"is everything OK\", \"did revenue drop\" or a daily check; use admobctl_insights for a fuller analysis. Earnings are estimates.",
		inputSchema: {
			window_days: number().int().min(1).max(90).optional().describe("Complete days to judge, ending yesterday (default 1)"),
			baseline_days: number().int().min(1).max(366).optional().describe("Days just before the window to compare with (default 7)"),
			drop_percent: number().int().min(1).max(99).optional().describe("A drop of this percent or more is a breach (default 30)"),
			min_requests: number().int().positive().optional().describe("Baseline requests an app needs before it is judged (default 1000)"),
			...appArg,
			...accountArg
		},
		outputSchema: loose({
			window: anyRecord,
			baseline: anyRecord,
			thresholds: anyRecord,
			currency: string(),
			estimate: literal(true),
			breaches: number(),
			rows: array(anyRecord),
			total: anyRecord.optional(),
			findings: array(anyRecord),
			summary: array(string()),
			notices: array(string())
		}),
		annotations
	}, wrap(async (a) => fitRows({ ...await check(svc(a), {
		window: a.window_days,
		baseline: a.baseline_days,
		drop: a.drop_percent === void 0 ? void 0 : a.drop_percent / 100,
		minRequests: a.min_requests,
		app: a.app
	}) })));
	server.registerTool("admobctl_campaign_report", {
		title: "AdMob campaign report",
		description: "Report on the user's AdMob app-promotion campaigns (the user as advertiser): impressions, clicks, CTR, installs, estimated cost and average CPI by campaign, ad, placement, country, format or date. AdMob API v1beta; ranges over 30 days are fetched in chunks. Cost is in the campaigns' reporting currency.",
		inputSchema: {
			from: string().describe("Start date, YYYY-MM (whole month) or YYYY-MM-DD"),
			to: string().optional().describe("End date, YYYY-MM or YYYY-MM-DD. Defaults to `from`."),
			by: array(string()).optional().describe("Dimensions: campaign, campaign-id, ad, ad-id, placement, placement-id, placement-platform, country, format, date. Default [\"campaign\"]."),
			metrics: array(string()).optional().describe("Metrics: impressions, clicks, ctr, installs, cost, cpi, interactions. Default: all but interactions."),
			...accountArg
		},
		outputSchema: reportOutput,
		annotations
	}, wrap(async (a) => reportPayload(await svc(a).campaignReport({
		from: a.from,
		to: a.to ?? a.from,
		by: a.by?.length ? a.by : ["campaign"],
		metrics: a.metrics
	}))));
	server.registerTool("admobctl_list_ad_sources", {
		title: "List AdMob mediation ad sources",
		description: "List the ad sources (ad networks) available for AdMob mediation, with their IDs. AdMob API v1beta.",
		inputSchema: { ...accountArg },
		outputSchema: loose({ adSources: array(anyRecord) }),
		annotations
	}, wrap(async (a) => ({ adSources: await svc(a).adSources() })));
	server.registerTool("admobctl_list_adapters", {
		title: "List an ad source's adapters",
		description: "List the adapters of one mediation ad source (per platform and format) and the settings an ad unit mapping for each adapter needs. AdMob API v1beta.",
		inputSchema: {
			ad_source: string().describe("Ad source title or ID, from admobctl_list_ad_sources"),
			...accountArg
		},
		outputSchema: loose({ adapters: array(anyRecord) }),
		annotations
	}, wrap(async (a) => ({ adapters: await svc(a).adapters(a.ad_source) })));
	server.registerTool("admobctl_list_mediation_groups", {
		title: "List AdMob mediation groups",
		description: "List mediation groups with their targeting (platform, format, ad units, regions), their lines (ad source, CPM mode, manual CPM in USD, state, A/B variant) and whether a mediation A/B experiment is running. AdMob API v1beta; Google may require allowlisting.",
		inputSchema: {
			app: string().optional().describe("Only groups targeting this app (alias, app ID or name)"),
			ad_source: string().optional().describe("Only groups with a line for this ad source (title or ID)"),
			format: string().optional().describe("e.g. BANNER, INTERSTITIAL, REWARDED"),
			platform: string().optional().describe("IOS or ANDROID"),
			state: string().optional().describe("ENABLED or DISABLED"),
			...accountArg
		},
		outputSchema: loose({ mediationGroups: array(anyRecord) }),
		annotations
	}, wrap(async (a) => ({ mediationGroups: await svc(a).mediationGroups({
		app: a.app,
		adSource: a.ad_source,
		format: a.format,
		platform: a.platform,
		state: a.state
	}) })));
	server.registerTool("admobctl_list_ad_unit_mappings", {
		title: "List an ad unit's mappings",
		description: "List the third-party ad unit mappings of one ad unit: adapter ID, state and the network-specific settings (e.g. placement IDs). AdMob API v1beta; Google may require allowlisting.",
		inputSchema: {
			ad_unit: string().describe("Ad unit name or ID, from admobctl_list_ad_units"),
			...accountArg
		},
		outputSchema: loose({ adUnitMappings: array(anyRecord) }),
		annotations
	}, wrap(async (a) => ({ adUnitMappings: await svc(a).adUnitMappings(a.ad_unit) })));
	const rangeInput = {
		last_days: number().int().min(1).max(366).optional().describe("The last N complete days (default 30)"),
		from: string().optional().describe("Start, YYYY-MM or YYYY-MM-DD (instead of last_days)"),
		to: string().optional().describe("End, YYYY-MM or YYYY-MM-DD")
	};
	const range = (a) => ({
		last: a.last_days,
		from: a.from,
		to: a.to
	});
	const analysisOutput = (shape) => loose({
		from: string(),
		to: string(),
		rows: array(anyRecord),
		highlights: array(anyRecord),
		summary: array(string()),
		notices: array(string()),
		...shape
	});
	server.registerTool("admobctl_analyze_versions", {
		title: "AdMob version health",
		description: "Match rate, show rate and CTR per Google Mobile Ads SDK version (by platform), app version (by app) or OS version, comparing each version with the rest of its group. Highlights versions that fill or show worse, e.g. after an SDK upgrade or app release. Rows with enough_data=false have too few requests to judge: do not report their rates as problems. Traffic metrics only: the AdMob API does not split earnings by version.",
		inputSchema: {
			by: _enum(VERSION_KINDS).optional().describe("sdk (default), app or os"),
			...appArg,
			...rangeInput,
			...accountArg
		},
		outputSchema: analysisOutput({
			by: string(),
			group_by: string()
		}),
		annotations
	}, wrap(async (a) => fitRows({ ...await analyzeVersions(svc(a), {
		...range(a),
		by: a.by ?? "sdk",
		app: a.app
	}) })));
	server.registerTool("admobctl_analyze_consent", {
		title: "AdMob consent impact",
		description: "Ad requests, earnings and eCPM per app and serving restriction (no restriction, non-personalized, limited ads, RDP…), with each restricted mode's eCPM relative to the same app's unrestricted traffic, and the share of traffic served under a restriction per app (`apps`) and overall. One call covers every app. Rows with enough_data=false have too few requests, or too small an unrestricted baseline, to judge. Earnings are estimates. Data starts 2021-03-13.",
		inputSchema: {
			...appArg,
			...rangeInput,
			...currencyArg,
			...accountArg
		},
		outputSchema: analysisOutput({
			currency: string(),
			estimate: literal(true),
			apps: array(anyRecord),
			restricted_request_share: number().optional()
		}),
		annotations
	}, wrap(async (a) => fitRows({ ...await analyzeConsent(svc(a), {
		...range(a),
		app: a.app,
		currency: a.currency
	}) })));
	server.registerTool("admobctl_analyze_waterfall", {
		title: "AdMob mediation waterfall",
		description: "Mediation lines (ad source instances) per mediation group, sorted by observed eCPM, with each line's share of the group's earnings, requests and match rate. Highlights the top line per group, idle lines (requests but no impressions) and lines that rarely fill. Earnings are estimates.",
		inputSchema: {
			...appArg,
			group: string().optional().describe("Only this mediation group (name or ID)"),
			...rangeInput,
			...currencyArg,
			...accountArg
		},
		outputSchema: analysisOutput({
			currency: string(),
			estimate: literal(true),
			groups: array(anyRecord)
		}),
		annotations
	}, wrap(async (a) => fitRows({ ...await analyzeWaterfall(svc(a), {
		...range(a),
		app: a.app,
		group: a.group,
		currency: a.currency
	}) })));
	server.registerTool("admobctl_analyze_geo", {
		title: "AdMob country and format mix",
		description: "Earnings, share, requests, match rate, show rate and eCPM per country and ad format, with each cell's eCPM relative to its format across all countries, plus totals per country (`countries`). Highlights: concentration (one country brings half or more of the earnings), low-fill (a big cell fills far worse than the same format elsewhere) and high-ecpm (a small cell pays 1.5× its format's average or more). Rows with enough_data=false have too few requests to judge. Earnings are estimates.",
		inputSchema: {
			...appArg,
			min_requests: number().int().positive().optional().describe("Requests a country and format need before they are judged (default 1000)"),
			...rangeInput,
			...currencyArg,
			...accountArg
		},
		outputSchema: analysisOutput({
			currency: string(),
			estimate: literal(true),
			countries: array(anyRecord)
		}),
		annotations
	}, wrap(async (a) => {
		const r = await analyzeGeo(svc(a), {
			...range(a),
			app: a.app,
			minRequests: a.min_requests,
			currency: a.currency
		});
		const notices = r.countries.length > GEO_MAX_COUNTRIES ? [...r.notices, `\`countries\` lists the ${GEO_MAX_COUNTRIES} biggest of ${r.countries.length} countries; the rows cover all of them.`] : r.notices;
		return fitRows({
			...r,
			countries: r.countries.slice(0, GEO_MAX_COUNTRIES),
			notices
		});
	}));
	server.registerTool("admobctl_lint", {
		title: "Lint the AdMob setup",
		description: "Check the account's setup for things that are broken or unused. Problems (they limit or stop ad serving): apps marked action required, enabled mediation groups whose targeted ad units are all gone or that have no enabled line. Notes (worth a look, often intentional): apps in review, groups that also target an ad unit that is gone, ad units with no ad requests in the period, ad units in no enabled mediation group. `problems` counts the problems; each finding has a kind, severity, target and message. Mediation checks are skipped with a notice when the account cannot read mediation groups (AdMob API v1beta).",
		inputSchema: {
			...appArg,
			...rangeInput,
			...accountArg
		},
		outputSchema: loose({
			from: string(),
			to: string(),
			checked: anyRecord,
			problems: number(),
			findings: array(anyRecord),
			summary: array(string()),
			notices: array(string())
		}),
		annotations
	}, wrap(async (a) => ({ ...await lint(svc(a), {
		...range(a),
		app: a.app
	}) })));
	server.registerTool("admobctl_analyze_trend", {
		title: "AdMob daily trend",
		description: "Daily earnings as a series, to answer \"when did it change?\": per series the day earnings moved to a new level (`shift`: date, before and after per day, change), the average per weekday, and the first day with traffic. One series for the whole account or one app, or split by app, format, country or platform (the ten biggest). Days without traffic before a series starts are left out of the averages. Set include_days for the day-by-day rows. Earnings are estimates.",
		inputSchema: {
			by: _enum(TREND_SPLITS).optional().describe("One series per app, format, country or platform. Default: total (one series)."),
			...appArg,
			include_days: boolean().optional().describe("Also return each series' daily rows (default false)"),
			...rangeInput,
			...currencyArg,
			...accountArg
		},
		outputSchema: analysisOutput({
			by: string(),
			currency: string(),
			estimate: literal(true)
		}),
		annotations
	}, wrap(async (a) => {
		const r = await analyzeTrend(svc(a), {
			...range(a),
			by: a.by,
			app: a.app,
			currency: a.currency,
			days: a.include_days === true
		});
		if (textOf(r).length > 6e4) {
			for (const s of r.rows) delete s.days;
			r.notices.push("The daily rows did not fit the context limit and were left out. Ask for a shorter range, one app, or no split.");
		}
		return fitRows({ ...r });
	}));
	return server;
}
/** Run over stdio. stdout carries the protocol only; all logs go to stderr. */
async function runStdioServer(deps) {
	await createMcpServer(deps).connect(new StdioServerTransport());
	log.debug("MCP server ready on stdio");
}

//#endregion
export { MAX_TEXT_CHARS, SERVICE_TTL_MS, createMcpServer, fitRows, runStdioServer };