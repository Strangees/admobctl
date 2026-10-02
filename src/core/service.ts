import { buildAppIndex, resolveApp, type AppRef } from "./aliases.js";
import { resolveTokenProvider } from "./auth/index.js";
import type { TokenProvider } from "./auth/types.js";
import { AdmobClient, type PublisherAccount } from "./client.js";
import { configDir, loadConfig, resolveProfile, type ResolvedProfile } from "./config.js";
import { dateRangeFromArgs, formatDate, type DateRange } from "./dates.js";
import { AdmobctlError } from "./errors.js";
import type { Exec } from "./exec.js";
import { buildReportSpec, normalizeDimension, normalizeMetric, type Report, type ReportKind } from "./report.js";
import { computeTotals, toViewRows, type ViewRow } from "./report-view.js";

export interface ServiceOptions {
  profile?: string;
  account?: string;
}

export interface ServiceDeps {
  configDir?: string;
  tokenProvider?: TokenProvider;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  exec?: Exec;
  now?: () => Date;
}

export interface AdUnitView {
  name: string;
  adUnitId: string;
  app: string;
  appId: string;
  format: string;
  adTypes: string[];
}

export const DEFAULT_METRICS: Record<ReportKind, string[]> = {
  network: [
    "ESTIMATED_EARNINGS", "AD_REQUESTS", "MATCHED_REQUESTS", "IMPRESSIONS", "CLICKS",
    "MATCH_RATE", "SHOW_RATE", "IMPRESSION_CTR", "IMPRESSION_RPM",
  ],
  mediation: ["ESTIMATED_EARNINGS", "AD_REQUESTS", "MATCHED_REQUESTS", "IMPRESSIONS", "CLICKS", "MATCH_RATE", "OBSERVED_ECPM"],
};

export interface ReportQuery {
  from?: string;
  to?: string;
  /** Alternative to from/to. */
  dateRange?: DateRange;
  by: string[];
  metrics?: string[];
  /** friendly dimension → values; app filters accept aliases. */
  filters?: Record<string, string[]>;
  maxRows?: number;
}

export interface ReportResult {
  kind: ReportKind;
  account: string;
  currency?: string;
  timeZone?: string;
  from: string;
  to: string;
  dimensions: string[];
  metrics: string[];
  rows: ViewRow[];
  /** Omitted when the report is truncated (a partial sum would mislead). */
  totals?: ViewRow;
  truncated: boolean;
  /** Total rows matching the query, when the API reports it. */
  matchingRowCount?: number;
  warnings: string[];
}

/**
 * The single core used by both the CLI and the MCP server.
 * Everything user-facing is resolved here: profile, auth, account, aliases.
 */
export class AdmobService {
  private accountPromise?: Promise<PublisherAccount>;
  private appsPromise?: Promise<AppRef[]>;

  private constructor(
    readonly profile: ResolvedProfile,
    readonly client: AdmobClient,
    readonly tokenProvider: TokenProvider,
    private readonly accountOverride: string | undefined,
    readonly now: () => Date,
  ) {}

  static create(opts: ServiceOptions = {}, deps: ServiceDeps = {}): AdmobService {
    const dir = deps.configDir ?? configDir();
    const profile = resolveProfile(loadConfig(dir), opts.profile);
    const tokenProvider = deps.tokenProvider ?? resolveTokenProvider(profile, { configDir: dir, exec: deps.exec, fetch: deps.fetch });
    const client = new AdmobClient({
      getToken: () => tokenProvider.getToken(),
      quotaProject: profile.quotaProject ?? tokenProvider.quotaProject(),
      fetch: deps.fetch,
      sleep: deps.sleep,
    });
    return new AdmobService(profile, client, tokenProvider, opts.account ?? profile.account, deps.now ?? (() => new Date()));
  }

  /** The account that will be used (--account, then profile), without calling the API. Undefined means auto-detect. */
  get configuredAccount(): string | undefined {
    return this.accountOverride;
  }

  listAccounts(): Promise<PublisherAccount[]> {
    return this.client.listAccounts();
  }

  /** The active publisher account: --account, then profile, then the only accessible one. */
  account(): Promise<PublisherAccount> {
    this.accountPromise ??= (async () => {
      const accounts = await this.client.listAccounts();
      const ids = accounts.map((a) => a.publisherId).join(", ") || "(none)";
      const wanted = this.accountOverride?.replace(/^accounts\//, "");
      if (wanted) {
        const hit = accounts.find((a) => a.publisherId === wanted);
        if (!hit) throw new AdmobctlError("NOT_FOUND", `Account ${wanted} is not accessible. Accessible accounts: ${ids}`);
        return hit;
      }
      if (accounts.length === 1) return accounts[0]!;
      if (accounts.length === 0) {
        throw new AdmobctlError("NOT_FOUND", "The signed-in Google user has no AdMob accounts.", {
          fix: "Sign in with the Google user that owns your AdMob account.",
        });
      }
      throw new AdmobctlError("USAGE", `Several AdMob accounts are accessible (${ids}). Pick one.`, {
        fix: "admobctl config set account <pub-…>  (or pass --account)",
      });
    })();
    return this.accountPromise;
  }

  apps(): Promise<AppRef[]> {
    this.appsPromise ??= (async () => {
      const acct = await this.account();
      return buildAppIndex(await this.client.listApps(acct.name), this.profile.aliases);
    })();
    return this.appsPromise;
  }

  async resolveApp(input: string): Promise<AppRef> {
    return resolveApp(input, await this.apps());
  }

  async adUnits(opts: { app?: string } = {}): Promise<AdUnitView[]> {
    const acct = await this.account();
    const [apps, units] = await Promise.all([this.apps(), this.client.listAdUnits(acct.name)]);
    const filterApp = opts.app ? resolveApp(opts.app, apps) : undefined;
    const aliasById = new Map(apps.map((a) => [a.appId, a.alias]));
    return units
      .filter((u) => !filterApp || u.appId === filterApp.appId)
      .map((u) => ({
        name: u.displayName,
        adUnitId: u.adUnitId,
        app: aliasById.get(u.appId) ?? u.appId,
        appId: u.appId,
        format: u.adFormat,
        adTypes: u.adTypes ?? [],
      }));
  }

  networkReport(q: ReportQuery): Promise<ReportResult> {
    return this.report("network", q);
  }

  mediationReport(q: ReportQuery): Promise<ReportResult> {
    return this.report("mediation", q);
  }

  /** Raw report access for finance/insights, which need exact micros per row. */
  async rawReport(kind: ReportKind, q: ReportQuery): Promise<{ report: Report; dimensions: string[]; metrics: string[]; range: DateRange }> {
    const range = q.dateRange ?? dateRangeFromArgs(q.from ?? "", q.to ?? q.from ?? "");
    const dimensions = q.by.map((d) => normalizeDimension(d, kind));
    const metrics = (q.metrics?.length ? q.metrics : DEFAULT_METRICS[kind]).map((m) => normalizeMetric(m, kind));
    const filters = await this.resolveFilters(kind, q.filters ?? {});
    const spec = buildReportSpec(kind, { dateRange: range, dimensions, metrics, filters, maxRows: q.maxRows });
    const acct = await this.account();
    const report =
      kind === "network" ? await this.client.networkReport(acct.name, spec) : await this.client.mediationReport(acct.name, spec);
    return { report, dimensions, metrics, range };
  }

  private async resolveFilters(kind: ReportKind, filters: Record<string, string[]>): Promise<Record<string, string[]>> {
    const out: Record<string, string[]> = {};
    for (const [dim, values] of Object.entries(filters)) {
      const api = normalizeDimension(dim, kind);
      out[api] = api === "APP" ? await Promise.all(values.map(async (v) => (await this.resolveApp(v)).appId)) : values;
    }
    return out;
  }

  private async report(kind: ReportKind, q: ReportQuery): Promise<ReportResult> {
    const { report, dimensions, metrics, range } = await this.rawReport(kind, q);
    const needsApps = dimensions.includes("APP");
    const apps = needsApps ? await this.apps() : [];
    if (q.maxRows !== undefined && report.rows.length > q.maxRows) report.rows = report.rows.slice(0, q.maxRows);
    // Without a matchingRowCount, a report that fills the row cap may have been cut short.
    const truncated =
      report.matchingRowCount !== undefined
        ? report.matchingRowCount > report.rows.length
        : q.maxRows !== undefined && report.rows.length >= q.maxRows;
    const acct = await this.account();
    const result: ReportResult = {
      kind,
      account: acct.publisherId,
      currency: report.currency ?? acct.currencyCode,
      timeZone: report.timeZone ?? acct.reportingTimeZone,
      from: formatDate(range.startDate),
      to: formatDate(range.endDate),
      dimensions: dimensions.map((d) => d.toLowerCase()),
      metrics: metrics.map((m) => m.toLowerCase()),
      rows: toViewRows(report, dimensions, metrics, apps),
      truncated,
      warnings: report.warnings,
    };
    if (!truncated) result.totals = computeTotals(report, metrics);
    if (report.matchingRowCount !== undefined) result.matchingRowCount = report.matchingRowCount;
    return result;
  }
}
