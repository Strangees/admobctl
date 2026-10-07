import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { analyzeConsent, analyzeVersions, analyzeWaterfall, VERSION_KINDS } from "../core/analyze.js";
import { checkAppAds } from "../core/app-ads.js";
import { check } from "../core/check.js";
import { AdmobctlError } from "../core/errors.js";
import { financeForecast, financeMonth, financeRange, JOURNAL_COLUMNS, journalRows } from "../core/finance.js";
import { financeBalance } from "../core/payments.js";
import { setupStatus } from "../core/setup/status.js";
import { exportJournal } from "../core/journal.js";
import { analyzeGeo } from "../core/geo.js";
import { INSIGHT_DIMENSIONS, insights } from "../core/insights.js";
import { lint } from "../core/lint.js";
import { log } from "../core/log.js";
import { shownRows } from "../core/report-view.js";
import { COMPARISONS, type AdmobService, type ReportResult, type ServiceOptions } from "../core/service.js";
import { renderTsv } from "../output/format.js";
import { analyzeTrend, TREND_SPLITS } from "../core/trend.js";
import { VERSION } from "../version.js";

/** ~25k tokens of JSON. Results above this are trimmed with a notice. */
export const MAX_TEXT_CHARS = 60_000;
export const DEFAULT_MAX_ROWS = 200;
const HARD_MAX_ROWS = 5000;

/** How long one AdmobService (and its cached account, apps index and token) is reused across tool calls. */
export const SERVICE_TTL_MS = 5 * 60_000;

export interface McpDeps {
  service: (opts: ServiceOptions) => AdmobService;
  /** Reuse window per account. Default SERVICE_TTL_MS. */
  serviceTtlMs?: number;
  /** Clock in ms, for tests. Default Date.now. */
  now?: () => number;
}

const INSTRUCTIONS = `Read-only access to the user's Google AdMob account via admobctl.
- Apps are referred to by alias (e.g. "my-game-ios"); call admobctl_list_apps to see them.
- All earnings are ESTIMATES. When reporting money, say so and that they should be reconciled against AdMob Payments (finalized).
- For "is everything OK?" or "did revenue drop?" use admobctl_check: it compares the last complete day with the same
  weekday in the four weeks before.
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

const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

const appArg = { app: z.string().optional().describe("Only this app (alias, app ID or name)") };
const accountArg = { account: z.string().optional().describe("Publisher ID (pub-…). Defaults to the configured or only account.") };
const currencyArg = {
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/, "an ISO 4217 code like USD")
    .optional()
    .describe("ISO 4217 code to convert earnings into, e.g. USD. Default: the account currency."),
};
const anyRecord = z.record(z.string(), z.unknown());
const loose = (shape: z.ZodRawShape) => z.looseObject(shape);

function textOf(data: unknown): string {
  return JSON.stringify(data);
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function ok(data: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: textOf(data) }], structuredContent: data };
}

function fail(err: unknown): ToolResult {
  const text =
    err instanceof AdmobctlError
      ? `${err.message}${err.fix ? `\nFix: ${err.fix}` : ""}`
      : `Unexpected error: ${(err as Error)?.message ?? String(err)}`;
  if (!(err instanceof AdmobctlError)) log.warn((err as Error)?.stack ?? String(err));
  return { content: [{ type: "text", text }], isError: true };
}

/** Per-country totals the geo tool returns; the rows still cover every country. */
const GEO_MAX_COUNTRIES = 25;

/** Drop trailing rows until the JSON fits the context budget. */
export function fitRows<T extends { rows: unknown[] }>(result: T & { truncated?: boolean; notice?: string }): T {
  if (textOf(result).length <= MAX_TEXT_CHARS) return result;
  const all = result.rows;
  let lo = 0;
  let hi = all.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = { ...result, rows: all.slice(0, mid), truncated: true, notice: "x".repeat(200) };
    if (textOf(candidate).length <= MAX_TEXT_CHARS) lo = mid;
    else hi = mid - 1;
  }
  return {
    ...result,
    rows: all.slice(0, lo),
    truncated: true,
    notice: `Showing ${lo} of ${all.length} returned rows to stay within the context limit. Narrow the query (fewer dimensions, a filter, or a shorter range) to see the rest.`,
  };
}

function reportPayload(r: ReportResult): Record<string, unknown> {
  const payload: ReportResult & { notice?: string } = { ...r };
  if (r.truncated) {
    payload.notice = `Truncated: ${shownRows(r)}. Raise max_rows (≤ ${HARD_MAX_ROWS}) or narrow the query.`;
  }
  return fitRows(payload) as unknown as Record<string, unknown>;
}

const reportInput = {
  from: z.string().describe("Start date, YYYY-MM (whole month) or YYYY-MM-DD"),
  to: z.string().optional().describe("End date, YYYY-MM or YYYY-MM-DD. Defaults to `from`."),
  by: z.array(z.string()).optional().describe('Dimensions, e.g. ["app"], ["ad-unit","country"], ["date"]. Default ["app"].'),
  metrics: z
    .array(z.string())
    .optional()
    .describe('Metrics, e.g. ["earnings","impressions","match-rate","show-rate","rpm"]. Default: all common metrics.'),
  filters: z
    .record(z.string(), z.array(z.string()))
    .optional()
    .describe('Dimension filters, e.g. {"country":["NO","SE"],"app":["my-game-ios"]}. App filters accept aliases.'),
  max_rows: z.number().int().positive().max(HARD_MAX_ROWS).optional().describe(`Row cap (default ${DEFAULT_MAX_ROWS}).`),
  sort: z
    .string()
    .optional()
    .describe('Sort by a dimension or metric of the report, e.g. "impressions", "match-rate:asc", "country". Default: by time, else by earnings.'),
  compare: z
    .enum(COMPARISONS)
    .optional()
    .describe("previous: add previous_<metric> and <metric>_change (a fraction) to each row and the totals, against the equal-length period just before. Not with date, week or month."),
  ...currencyArg,
  ...accountArg,
};

const reportOutput = loose({
  kind: z.string(),
  from: z.string(),
  to: z.string(),
  currency: z.string().optional(),
  rows: z.array(anyRecord),
  totals: anyRecord.optional(),
  truncated: z.boolean(),
  previous: anyRecord.optional(),
  notice: z.string().optional(),
  notices: z.array(z.string()),
});

export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: "admobctl", version: VERSION }, { instructions: INSTRUCTIONS });
  // One service per account argument, so tool calls share its account/apps/token caches.
  const ttl = deps.serviceTtlMs ?? SERVICE_TTL_MS;
  const now = deps.now ?? Date.now;
  const services = new Map<string, { svc: AdmobService; createdAt: number }>();
  const freshSvc = (a: { account?: string }): AdmobService => {
    const fresh = deps.service({ account: a.account });
    services.set(a.account ?? "", { svc: fresh, createdAt: now() });
    return fresh;
  };
  const svc = (a: { account?: string }): AdmobService => {
    const hit = services.get(a.account ?? "");
    if (hit && now() - hit.createdAt < ttl) return hit.svc;
    return freshSvc(a);
  };
  const wrap =
    <A>(fn: (args: A) => Promise<Record<string, unknown>>) =>
    async (args: A): Promise<ToolResult> => {
      try {
        return ok(await fn(args));
      } catch (err) {
        return fail(err);
      }
    };

  server.registerTool(
    "admobctl_list_accounts",
    {
      title: "List AdMob accounts",
      description: "List the AdMob publisher accounts the signed-in user can access (publisher ID, currency, reporting time zone).",
      inputSchema: {},
      outputSchema: loose({ accounts: z.array(anyRecord) }),
      annotations,
    },
    wrap(async () => ({ accounts: await svc({}).listAccounts() })),
  );

  server.registerTool(
    "admobctl_list_apps",
    {
      title: "List AdMob apps",
      description:
        "List apps in the AdMob account with their aliases (use the alias in other tools), platform, app ID, store ID and approval state (ACTION_REQUIRED means the app needs the publisher's attention in AdMob review; ad serving may be limited).",
      inputSchema: { ...accountArg },
      outputSchema: loose({ apps: z.array(anyRecord) }),
      annotations,
    },
    wrap(async (a: { account?: string }) => ({ apps: await svc(a).apps() })),
  );

  server.registerTool(
    "admobctl_check_app_ads",
    {
      title: "Check app-ads.txt",
      description:
        "Check each app's app-ads.txt the way AdMob's crawler does: the developer website from the App Store listing (Google Play listings cannot be read, so Android apps need `website` from the user or one saved with `admobctl config set websites.<alias> <url>`; do not guess it), https then http, and a google.com line with the publisher ID marked DIRECT. Per app: ok, missing-file (HTTP 404/410), html (a web page instead of the file), no-line, reseller-only, unreachable (network error, blocked request or server error: the file may exist), no-website, unknown-website or not-linked, plus the exact line to add. Fetches the store lookup and the developer websites, not just the AdMob API.",
      inputSchema: {
        ...appArg,
        website: z.string().optional().describe("Developer website for apps whose store listing cannot be read (Android), e.g. example.com"),
        ...accountArg,
      },
      outputSchema: loose({ publisherId: z.string(), expectedLine: z.string(), problems: z.number(), apps: z.array(anyRecord), summary: z.array(z.string()) }),
      annotations,
    },
    wrap(async (a: { app?: string; website?: string; account?: string }) =>
      (await checkAppAds(svc(a), { app: a.app, website: a.website })) as unknown as Record<string, unknown>,
    ),
  );

  server.registerTool(
    "admobctl_list_ad_units",
    {
      title: "List AdMob ad units",
      description: "List ad units (name, format, ad unit ID) for all apps or one app.",
      inputSchema: { app: z.string().optional().describe("App alias, app ID or name"), ...accountArg },
      outputSchema: loose({ adUnits: z.array(anyRecord) }),
      annotations,
    },
    wrap(async (a: { app?: string; account?: string }) => ({ adUnits: await svc(a).adUnits({ app: a.app }) })),
  );

  for (const kind of ["network", "mediation"] as const) {
    server.registerTool(
      `admobctl_${kind}_report`,
      {
        title: `AdMob ${kind} report`,
        description:
          kind === "network"
            ? "AdMob Network report: estimated earnings, requests, match rate, impressions, show rate, CTR and RPM by any dimension (app, ad-unit, country, format, platform, date, month…)."
            : "Mediation report across ad sources: earnings, requests, match rate, impressions, observed eCPM by ad-source, app, ad-unit, country…",
        inputSchema: reportInput,
        outputSchema: reportOutput,
        annotations,
      },
      wrap(async (a: { from: string; to?: string; by?: string[]; metrics?: string[]; filters?: Record<string, string[]>; max_rows?: number; sort?: string; compare?: string; currency?: string; account?: string }) => {
        const s = svc(a);
        const q = {
          from: a.from,
          to: a.to ?? a.from,
          by: a.by?.length ? a.by : ["app"],
          metrics: a.metrics,
          filters: a.filters,
          maxRows: a.max_rows ?? DEFAULT_MAX_ROWS,
          currency: a.currency,
          sort: a.sort,
          compare: a.compare,
        };
        return reportPayload(kind === "network" ? await s.networkReport(q) : await s.mediationReport(q));
      }),
    );
  }

  server.registerTool(
    "admobctl_finance_month",
    {
      title: "AdMob earnings for a month",
      description:
        "Estimated AdMob earnings for one calendar month, per app and in total, for bookkeeping. With include_journal, also returns Bilagsjournal rows (debit receivable, credit revenue per app, dated at month-end) and journal_tsv, a paste-ready tab-separated block to show verbatim. Figures are estimates, not finalized payments.",
      inputSchema: {
        month: z.string().describe("YYYY-MM"),
        include_journal: z.boolean().optional().describe("Also return journal rows"),
        ...accountArg,
      },
      outputSchema: loose({
        month: z.string(),
        currency: z.string(),
        complete: z.boolean(),
        estimate: z.literal(true),
        total: z.number(),
        apps: z.array(anyRecord),
        notes: z.array(z.string()),
        journal: z.array(anyRecord).optional(),
        journal_tsv: z.string().optional(),
      }),
      annotations,
    },
    wrap(async (a: { month: string; include_journal?: boolean; account?: string }) => {
      const s = svc(a);
      const m = await financeMonth(s, a.month);
      if (!a.include_journal) return { ...m };
      const journal = journalRows(m, s.profile.finance);
      const journal_tsv = renderTsv({ columns: JOURNAL_COLUMNS.map((c) => ({ key: c, label: c })), rows: journal });
      return { ...m, journal, journal_tsv };
    }),
  );

  server.registerTool(
    "admobctl_finance_range",
    {
      title: "AdMob earnings per month over a range",
      description: "Estimated AdMob earnings per month (and per app within each month) for a range of months, with a grand total. Estimates, not finalized payments.",
      inputSchema: { from: z.string().describe("First month, YYYY-MM"), to: z.string().describe("Last month, YYYY-MM"), ...accountArg },
      outputSchema: loose({
        from: z.string(),
        to: z.string(),
        currency: z.string(),
        estimate: z.literal(true),
        total: z.number(),
        months: z.array(anyRecord),
        notes: z.array(z.string()),
      }),
      annotations,
    },
    wrap(async (a: { from: string; to: string; account?: string }) => ({ ...(await financeRange(svc(a), a.from, a.to)) })),
  );

  server.registerTool(
    "admobctl_finance_forecast",
    {
      title: "AdMob month-end projection",
      description:
        "Month-to-date estimated earnings per app and a month-end projection: the daily average of the month's complete days carried to the end of the month. Defaults to the current month. A projection of estimates, for pacing only: never book it or present it as earnings. For a month that has ended it returns that month's estimate (projection=false).",
      inputSchema: { month: z.string().optional().describe("YYYY-MM. Default: the current month."), ...accountArg },
      outputSchema: loose({
        month: z.string(),
        currency: z.string(),
        complete: z.boolean(),
        estimate: z.literal(true),
        projection: z.boolean(),
        days_elapsed: z.number(),
        days_in_month: z.number(),
        month_to_date: z.number(),
        projected: z.number(),
        apps: z.array(anyRecord),
        notes: z.array(z.string()),
      }),
      annotations,
    },
    wrap(async (a: { month?: string; account?: string }) => ({ ...(await financeForecast(svc(a), a.month)) })),
  );

  server.registerTool(
    "admobctl_setup_status",
    {
      title: "admobctl setup status",
      description:
        "Checks the admobctl setup (credentials, scopes per feature, quota project, enabled APIs, AdMob account, app review, v1beta access). Each failing check has fix_command, a runnable admobctl command; next_command is the one to run first. Read-only: run the commands in the CLI.",
      inputSchema: { ...accountArg },
      outputSchema: loose({ ok: z.boolean(), checks: z.array(anyRecord), next_command: z.string().optional() }),
      annotations,
    },
    wrap(async (a: { account?: string }) => {
      // Never the cached service or token: the user may just have run a setup command (sign-in, quota project, features)
      // in a terminal. Replacing the cache entry and the shared token also lets the next tool call use the new setup.
      const s = freshSvc(a);
      s.tokenProvider.resetCache?.();
      return { ...(await setupStatus(s, { fetch: s.fetch })) };
    }),
  );

  server.registerTool(
    "admobctl_finance_balance",
    {
      title: "AdMob unpaid balance",
      description:
        "Current unpaid balance Google will pay out (AdSense Management API; includes AdMob earnings), in the account's payment currency. Not a monthly figure and not payment history. Needs a one-time extra sign-in scope; if it fails, pass the Fix line on.",
      inputSchema: { ...accountArg },
      outputSchema: loose({ account: z.string(), currency: z.string(), unpaid: z.number(), notes: z.array(z.string()) }),
      annotations,
    },
    wrap(async (a: { account?: string }) => ({ ...(await financeBalance(svc(a))) })),
  );

  server.registerTool(
    "admobctl_finance_export",
    {
      title: "Export AdMob accruals as Revenue Journal",
      description:
        "Accrual vouchers for one month or a range of months in the Revenue Journal format (an open format for platform revenue bookkeeping): one balanced voucher per month, debit the receivable, credit revenue per app. Returns `content`, the complete file as text (JSON document or CSV), to save or pass to an accounting import verbatim. Give either `month` or both `from` and `to`. Figures are estimates, not finalized payments.",
      inputSchema: {
        month: z.string().optional().describe("One month, YYYY-MM"),
        from: z.string().optional().describe("First month of a range, YYYY-MM (with `to`, instead of `month`)"),
        to: z.string().optional().describe("Last month of a range, YYYY-MM"),
        as: z.enum(["json", "csv"]).optional().describe("File format: json (default) or csv"),
        integer_amounts: z.boolean().optional().describe("JSON only: write amounts as integers instead of decimal strings"),
        scale: z.number().int().min(0).max(6).optional().describe("Decimal places the integers carry (default 2; 6 = micros). Needs integer_amounts."),
        ...accountArg,
      },
      outputSchema: loose({ as: z.string(), content: z.string(), notes: z.array(z.string()) }),
      annotations,
    },
    wrap(async (a: { month?: string; from?: string; to?: string; as?: "json" | "csv"; integer_amounts?: boolean; scale?: number; account?: string }) => {
      const as = `revenue-journal-${a.as ?? "json"}`;
      const r = await exportJournal(svc(a), { as, month: a.month, from: a.from, to: a.to, integerAmounts: a.integer_amounts, scale: a.scale });
      return { as, ...r };
    }),
  );

  server.registerTool(
    "admobctl_insights",
    {
      title: "AdMob monetization insights",
      description:
        "Analyze monetization: earnings, eCPM, request RPM, match (fill) rate, show rate and CTR per app/ad-unit/country/format/platform, compared with the previous period. Returns highlights (top and bottom earners, low fill, low show rate, big swings) and a plain-language summary with the numbers behind each claim.",
      inputSchema: {
        last_days: z.number().int().min(1).max(366).optional().describe("The last N complete days (default 30)"),
        from: z.string().optional().describe("Start, YYYY-MM or YYYY-MM-DD (instead of last_days)"),
        to: z.string().optional().describe("End, YYYY-MM or YYYY-MM-DD"),
        by: z.enum(INSIGHT_DIMENSIONS).optional().describe("Group by (default ad-unit)"),
        ...currencyArg,
        ...accountArg,
      },
      outputSchema: loose({
        from: z.string(),
        to: z.string(),
        currency: z.string(),
        estimate: z.literal(true),
        totals: anyRecord,
        rows: z.array(anyRecord),
        highlights: z.array(anyRecord),
        summary: z.array(z.string()),
      }),
      annotations,
    },
    wrap(async (a: { last_days?: number; from?: string; to?: string; by?: (typeof INSIGHT_DIMENSIONS)[number]; currency?: string; account?: string }) => {
      const r = await insights(svc(a), { last: a.last_days, from: a.from, to: a.to, by: a.by ?? "ad-unit", currency: a.currency });
      return fitRows({ ...r }) as unknown as Record<string, unknown>;
    }),
  );

  server.registerTool(
    "admobctl_check",
    {
      title: "AdMob health check",
      description:
        "Did anything break? Compares the last complete day(s) with the same weekdays in the 4 weeks before (or, with baseline_days, the days just before), per app and in total, and reports `findings` where daily earnings, match rate or show rate dropped by the threshold or more, or an app stopped sending ad requests (`breaches` is their count; 0 means nothing dropped). Rows with status `thin` had too little baseline traffic to judge: do not report them as problems. Use for \"is everything OK\", \"did revenue drop\" or a daily check; use admobctl_insights for a fuller analysis. Earnings are estimates.",
      inputSchema: {
        window_days: z.number().int().min(1).max(90).optional().describe("Complete days to judge, ending yesterday (default 1)"),
        baseline_weeks: z.number().int().min(1).max(52).optional().describe("Compare with the window's weekdays in this many weeks before it (default 4; window_days up to 7)"),
        baseline_days: z.number().int().min(1).max(366).optional().describe("Compare with this many days just before the window instead (default 7 when window_days is over 7)"),
        drop_percent: z.number().int().min(1).max(99).optional().describe("A drop of this percent or more is a breach (default 30)"),
        min_requests: z.number().int().positive().optional().describe("Baseline requests an app needs before it is judged (default 1000)"),
        ...appArg,
        ...accountArg,
      },
      outputSchema: loose({
        window: anyRecord,
        baseline: anyRecord,
        thresholds: anyRecord,
        currency: z.string(),
        estimate: z.literal(true),
        breaches: z.number(),
        rows: z.array(anyRecord),
        total: anyRecord.optional(),
        findings: z.array(anyRecord),
        summary: z.array(z.string()),
        notices: z.array(z.string()),
      }),
      annotations,
    },
    wrap(async (a: { window_days?: number; baseline_weeks?: number; baseline_days?: number; drop_percent?: number; min_requests?: number; app?: string; account?: string }) =>
      fitRows({
        ...(await check(svc(a), {
          window: a.window_days,
          baseline: a.baseline_days,
          baselineWeeks: a.baseline_weeks,
          drop: a.drop_percent === undefined ? undefined : a.drop_percent / 100,
          minRequests: a.min_requests,
          app: a.app,
        })),
      }) as unknown as Record<string, unknown>,
    ),
  );

  server.registerTool(
    "admobctl_campaign_report",
    {
      title: "AdMob campaign report",
      description:
        "Report on the user's AdMob app-promotion campaigns (the user as advertiser): impressions, clicks, CTR, installs, estimated cost and average CPI by campaign, ad, placement, country, format or date. AdMob API v1beta; ranges over 30 days are fetched in chunks. Cost is in the campaigns' reporting currency.",
      inputSchema: {
        from: z.string().describe("Start date, YYYY-MM (whole month) or YYYY-MM-DD"),
        to: z.string().optional().describe("End date, YYYY-MM or YYYY-MM-DD. Defaults to `from`."),
        by: z.array(z.string()).optional().describe('Dimensions: campaign, campaign-id, ad, ad-id, placement, placement-id, placement-platform, country, format, date. Default ["campaign"].'),
        metrics: z.array(z.string()).optional().describe("Metrics: impressions, clicks, ctr, installs, cost, cpi, interactions. Default: all but interactions."),
        ...accountArg,
      },
      outputSchema: reportOutput,
      annotations,
    },
    wrap(async (a: { from: string; to?: string; by?: string[]; metrics?: string[]; account?: string }) =>
      reportPayload(await svc(a).campaignReport({ from: a.from, to: a.to ?? a.from, by: a.by?.length ? a.by : ["campaign"], metrics: a.metrics })),
    ),
  );

  server.registerTool(
    "admobctl_list_ad_sources",
    {
      title: "List AdMob mediation ad sources",
      description: "List the ad sources (ad networks) available for AdMob mediation, with their IDs. AdMob API v1beta.",
      inputSchema: { ...accountArg },
      outputSchema: loose({ adSources: z.array(anyRecord) }),
      annotations,
    },
    wrap(async (a: { account?: string }) => ({ adSources: await svc(a).adSources() })),
  );

  server.registerTool(
    "admobctl_list_adapters",
    {
      title: "List an ad source's adapters",
      description:
        "List the adapters of one mediation ad source (per platform and format) and the settings an ad unit mapping for each adapter needs. AdMob API v1beta.",
      inputSchema: { ad_source: z.string().describe("Ad source title or ID, from admobctl_list_ad_sources"), ...accountArg },
      outputSchema: loose({ adapters: z.array(anyRecord) }),
      annotations,
    },
    wrap(async (a: { ad_source: string; account?: string }) => ({ adapters: await svc(a).adapters(a.ad_source) })),
  );

  server.registerTool(
    "admobctl_list_mediation_groups",
    {
      title: "List AdMob mediation groups",
      description:
        "List mediation groups with their targeting (platform, format, ad units, regions), their lines (ad source, CPM mode, manual CPM in USD, state, A/B variant) and whether a mediation A/B experiment is running. AdMob API v1beta; Google may require allowlisting.",
      inputSchema: {
        app: z.string().optional().describe("Only groups targeting this app (alias, app ID or name)"),
        ad_source: z.string().optional().describe("Only groups with a line for this ad source (title or ID)"),
        format: z.string().optional().describe("e.g. BANNER, INTERSTITIAL, REWARDED"),
        platform: z.string().optional().describe("IOS or ANDROID"),
        state: z.string().optional().describe("ENABLED or DISABLED"),
        ...accountArg,
      },
      outputSchema: loose({ mediationGroups: z.array(anyRecord) }),
      annotations,
    },
    wrap(async (a: { app?: string; ad_source?: string; format?: string; platform?: string; state?: string; account?: string }) => ({
      mediationGroups: await svc(a).mediationGroups({ app: a.app, adSource: a.ad_source, format: a.format, platform: a.platform, state: a.state }),
    })),
  );

  server.registerTool(
    "admobctl_list_ad_unit_mappings",
    {
      title: "List an ad unit's mappings",
      description:
        "List the third-party ad unit mappings of one ad unit: adapter ID, state and the network-specific settings (e.g. placement IDs). AdMob API v1beta; Google may require allowlisting.",
      inputSchema: { ad_unit: z.string().describe("Ad unit name or ID, from admobctl_list_ad_units"), ...accountArg },
      outputSchema: loose({ adUnitMappings: z.array(anyRecord) }),
      annotations,
    },
    wrap(async (a: { ad_unit: string; account?: string }) => ({ adUnitMappings: await svc(a).adUnitMappings(a.ad_unit) })),
  );

  const rangeInput = {
    last_days: z.number().int().min(1).max(366).optional().describe("The last N complete days (default 30)"),
    from: z.string().optional().describe("Start, YYYY-MM or YYYY-MM-DD (instead of last_days)"),
    to: z.string().optional().describe("End, YYYY-MM or YYYY-MM-DD"),
  };
  type RangeArgs = { last_days?: number; from?: string; to?: string; account?: string };
  const range = (a: RangeArgs) => ({ last: a.last_days, from: a.from, to: a.to });
  const analysisOutput = (shape: z.ZodRawShape) =>
    loose({ from: z.string(), to: z.string(), rows: z.array(anyRecord), highlights: z.array(anyRecord), summary: z.array(z.string()), notices: z.array(z.string()), ...shape });

  server.registerTool(
    "admobctl_analyze_versions",
    {
      title: "AdMob version health",
      description:
        "Match rate, show rate and CTR per Google Mobile Ads SDK version (by platform), app version (by app) or OS version, comparing each version with the rest of its group. Highlights versions that fill or show worse, e.g. after an SDK upgrade or app release. Rows with enough_data=false have too few requests to judge: do not report their rates as problems. Traffic metrics only: the AdMob API does not split earnings by version.",
      inputSchema: { by: z.enum(VERSION_KINDS).optional().describe("sdk (default), app or os"), ...appArg, ...rangeInput, ...accountArg },
      outputSchema: analysisOutput({ by: z.string(), group_by: z.string() }),
      annotations,
    },
    wrap(async (a: RangeArgs & { by?: (typeof VERSION_KINDS)[number]; app?: string }) =>
      fitRows({ ...(await analyzeVersions(svc(a), { ...range(a), by: a.by ?? "sdk", app: a.app })) }) as unknown as Record<string, unknown>,
    ),
  );

  server.registerTool(
    "admobctl_analyze_consent",
    {
      title: "AdMob consent impact",
      description:
        "Ad requests, earnings and eCPM per app and serving restriction (no restriction, non-personalized, limited ads, RDP…), with each restricted mode's eCPM relative to the same app's unrestricted traffic, and the share of traffic served under a restriction per app (`apps`) and overall. One call covers every app. Rows with enough_data=false have too few requests, or too small an unrestricted baseline, to judge. Earnings are estimates. Data starts 2021-03-13.",
      inputSchema: { ...appArg, ...rangeInput, ...currencyArg, ...accountArg },
      outputSchema: analysisOutput({ currency: z.string(), estimate: z.literal(true), apps: z.array(anyRecord), restricted_request_share: z.number().optional() }),
      annotations,
    },
    wrap(async (a: RangeArgs & { app?: string; currency?: string }) =>
      fitRows({ ...(await analyzeConsent(svc(a), { ...range(a), app: a.app, currency: a.currency })) }) as unknown as Record<string, unknown>,
    ),
  );

  server.registerTool(
    "admobctl_analyze_waterfall",
    {
      title: "AdMob mediation waterfall",
      description:
        "Mediation lines (ad source instances) per mediation group, sorted by observed eCPM, with each line's share of the group's earnings, requests and match rate. Highlights the top line per group, idle lines (requests but no impressions) and lines that rarely fill. Earnings are estimates.",
      inputSchema: {
        ...appArg,
        group: z.string().optional().describe("Only this mediation group (name or ID)"),
        ...rangeInput,
        ...currencyArg,
        ...accountArg,
      },
      outputSchema: analysisOutput({ currency: z.string(), estimate: z.literal(true), groups: z.array(anyRecord) }),
      annotations,
    },
    wrap(async (a: RangeArgs & { app?: string; group?: string; currency?: string }) =>
      fitRows({ ...(await analyzeWaterfall(svc(a), { ...range(a), app: a.app, group: a.group, currency: a.currency })) }) as unknown as Record<string, unknown>,
    ),
  );

  server.registerTool(
    "admobctl_analyze_geo",
    {
      title: "AdMob country and format mix",
      description:
        "Earnings, share, requests, match rate, show rate and eCPM per country and ad format, with each cell's eCPM relative to its format across all countries, plus totals per country (`countries`). Highlights: concentration (one country brings half or more of the earnings), low-fill (a big cell fills far worse than the same format elsewhere) and high-ecpm (a small cell pays 1.5× its format's average or more). Rows with enough_data=false have too few requests to judge. Earnings are estimates.",
      inputSchema: {
        ...appArg,
        min_requests: z.number().int().positive().optional().describe("Requests a country and format need before they are judged (default 1000)"),
        ...rangeInput,
        ...currencyArg,
        ...accountArg,
      },
      outputSchema: analysisOutput({ currency: z.string(), estimate: z.literal(true), countries: z.array(anyRecord) }),
      annotations,
    },
    wrap(async (a: RangeArgs & { app?: string; min_requests?: number; currency?: string }) => {
      const r = await analyzeGeo(svc(a), { ...range(a), app: a.app, minRequests: a.min_requests, currency: a.currency });
      // The per-country totals repeat what the rows hold: keep the biggest so the rows get the room.
      const notices =
        r.countries.length > GEO_MAX_COUNTRIES
          ? [...r.notices, `\`countries\` lists the ${GEO_MAX_COUNTRIES} biggest of ${r.countries.length} countries; the rows cover all of them.`]
          : r.notices;
      return fitRows({ ...r, countries: r.countries.slice(0, GEO_MAX_COUNTRIES), notices }) as unknown as Record<string, unknown>;
    }),
  );

  server.registerTool(
    "admobctl_lint",
    {
      title: "Lint the AdMob setup",
      description:
        "Check the account's setup for things that are broken or unused. Problems (they limit or stop ad serving): apps marked action required, enabled mediation groups whose targeted ad units are all gone or that have no enabled line. Notes (worth a look, often intentional): apps in review, groups that also target an ad unit that is gone, ad units with no ad requests in the period, ad units in no enabled mediation group. `problems` counts the problems; each finding has a kind, severity, target and message. Mediation checks are skipped with a notice when the account cannot read mediation groups (AdMob API v1beta).",
      inputSchema: { ...appArg, ...rangeInput, ...accountArg },
      outputSchema: loose({ from: z.string(), to: z.string(), checked: anyRecord, problems: z.number(), findings: z.array(anyRecord), summary: z.array(z.string()), notices: z.array(z.string()) }),
      annotations,
    },
    wrap(async (a: RangeArgs & { app?: string }) => ({ ...(await lint(svc(a), { ...range(a), app: a.app })) })),
  );

  server.registerTool(
    "admobctl_analyze_trend",
    {
      title: "AdMob daily trend",
      description:
        "Daily earnings as a series, to answer \"when did it change?\": per series the day earnings moved to a new level (`shift`: date, before and after per day, change), the average per weekday, and the first day with traffic. One series for the whole account or one app, or split by app, format, country or platform (the ten biggest). Days without traffic before a series starts are left out of the averages. Set include_days for the day-by-day rows. Earnings are estimates.",
      inputSchema: {
        by: z.enum(TREND_SPLITS).optional().describe("One series per app, format, country or platform. Default: total (one series)."),
        ...appArg,
        include_days: z.boolean().optional().describe("Also return each series' daily rows (default false)"),
        ...rangeInput,
        ...currencyArg,
        ...accountArg,
      },
      outputSchema: analysisOutput({ by: z.string(), currency: z.string(), estimate: z.literal(true) }),
      annotations,
    },
    wrap(async (a: RangeArgs & { by?: (typeof TREND_SPLITS)[number]; app?: string; include_days?: boolean; currency?: string }) => {
      const r = await analyzeTrend(svc(a), { ...range(a), by: a.by, app: a.app, currency: a.currency, days: a.include_days === true });
      // Daily rows sit inside each series, where fitRows cannot trim them: drop them if they do not fit.
      if (textOf(r).length > MAX_TEXT_CHARS) {
        for (const s of r.rows) delete s.days;
        r.notices.push("The daily rows did not fit the context limit and were left out. Ask for a shorter range, one app, or no split.");
      }
      return fitRows({ ...r }) as unknown as Record<string, unknown>;
    }),
  );

  return server;
}

/** Run over stdio. stdout carries the protocol only; all logs go to stderr. */
export async function runStdioServer(deps: McpDeps): Promise<void> {
  const server = createMcpServer(deps);
  await server.connect(new StdioServerTransport());
  log.debug("MCP server ready on stdio");
}
