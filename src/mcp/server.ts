import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AdmobctlError } from "../core/errors.js";
import { financeMonth, financeRange, JOURNAL_COLUMNS, journalRows } from "../core/finance.js";
import { INSIGHT_DIMENSIONS, insights } from "../core/insights.js";
import { log } from "../core/log.js";
import { shownRows } from "../core/report-view.js";
import type { AdmobService, ReportResult, ServiceOptions } from "../core/service.js";
import { renderTsv } from "../output/format.js";
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
- For "what did I earn in <month>" use admobctl_finance_month; for trends and recommendations use admobctl_insights.
- Errors include a "Fix:" line with the exact command the user should run.`;

const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

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
  notice: z.string().optional(),
  notices: z.array(z.string()),
});

export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: "admobctl", version: VERSION }, { instructions: INSTRUCTIONS });
  // One service per account argument, so tool calls share its account/apps/token caches.
  const ttl = deps.serviceTtlMs ?? SERVICE_TTL_MS;
  const now = deps.now ?? Date.now;
  const services = new Map<string, { svc: AdmobService; createdAt: number }>();
  const svc = (a: { account?: string }): AdmobService => {
    const key = a.account ?? "";
    const hit = services.get(key);
    if (hit && now() - hit.createdAt < ttl) return hit.svc;
    const fresh = deps.service({ account: a.account });
    services.set(key, { svc: fresh, createdAt: now() });
    return fresh;
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
      wrap(async (a: { from: string; to?: string; by?: string[]; metrics?: string[]; filters?: Record<string, string[]>; max_rows?: number; currency?: string; account?: string }) => {
        const s = svc(a);
        const q = {
          from: a.from,
          to: a.to ?? a.from,
          by: a.by?.length ? a.by : ["app"],
          metrics: a.metrics,
          filters: a.filters,
          maxRows: a.max_rows ?? DEFAULT_MAX_ROWS,
          currency: a.currency,
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

  return server;
}

/** Run over stdio. stdout carries the protocol only; all logs go to stderr. */
export async function runStdioServer(deps: McpDeps): Promise<void> {
  const server = createMcpServer(deps);
  await server.connect(new StdioServerTransport());
  log.debug("MCP server ready on stdio");
}
