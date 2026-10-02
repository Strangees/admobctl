import { buildAppIndex, resolveApp, type AppRef } from "./aliases.js";
import { resolveTokenProvider } from "./auth/index.js";
import type { TokenProvider } from "./auth/types.js";
import { mergeCampaignChunks, RATIO_BASES } from "./campaign.js";
import { AdmobClient, type AdSource, type AdUnit, type PublisherAccount } from "./client.js";
import { configDir, loadConfig, resolveProfile, type ResolvedProfile } from "./config.js";
import { dateRangeFromArgs, formatDate, splitRange, todayIn, type DateRange } from "./dates.js";
import { AdmobctlError, usageError } from "./errors.js";
import type { Exec } from "./exec.js";
import { freshnessNotices } from "./freshness.js";
import {
  API_MAX_ROWS,
  buildReportSpec,
  checkCombination,
  compatibleMetrics,
  friendlyMetric,
  friendlyName,
  normalizeDimension,
  normalizeMetric,
  type Report,
  type ReportKind,
} from "./report.js";
import { computeTotals, dimensionKey, metricKey, toViewRows, type ViewRow } from "./report-view.js";

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
  campaign: ["IMPRESSIONS", "CLICKS", "CLICK_THROUGH_RATE", "INSTALLS", "ESTIMATED_COST", "AVERAGE_CPI"],
};

/** The reports served by v1 networkReport/mediationReport:generate (campaign reports have their own method). */
export type StreamedReportKind = Exclude<ReportKind, "campaign">;

/** campaignReport:generate accepts at most 30 days per request. */
export const CAMPAIGN_MAX_DAYS = 30;

export interface AdapterView {
  adapterId: string;
  title: string;
  adSource: string;
  adSourceId: string;
  platform: string;
  formats: string[];
  /** The keys an ad unit mapping for this adapter fills in (adUnitConfigurations). */
  settings: Array<{ id: string; label: string; required: boolean }>;
}

export interface MediationLineView {
  id: string;
  name: string;
  adSource: string;
  adSourceId: string;
  cpmMode: string;
  /** Manual CPM in USD (the only currency the API supports for lines); absent for LIVE lines. */
  cpm?: number;
  cpm_micros?: number;
  state: string;
  /** A/B experiment variant: A (control) or B (treatment). */
  variant?: "A" | "B";
  /** ad unit ID → ad unit mapping resource name */
  mappings: Record<string, string>;
}

export interface MediationGroupView {
  id: string;
  name: string;
  state: string;
  platform: string;
  format: string;
  adUnits: Array<{ adUnitId: string; name: string; app: string }>;
  regions: string[];
  excludedRegions: string[];
  idfa?: string;
  /** Mediation A/B experiment: running or none. */
  experiment: "running" | "none" | "unknown";
  lines: MediationLineView[];
  resource: string;
}

export interface MediationGroupFilter {
  app?: string;
  adSource?: string;
  format?: string;
  platform?: string;
  state?: string;
}

export interface AdUnitMappingView {
  id: string;
  name: string;
  adUnit: string;
  adUnitId: string;
  adapterId: string;
  state: string;
  /** adapter setting ID → value */
  settings: Record<string, string>;
  resource: string;
}

/** Quote a value for the API's EBNF filter syntax. */
const filterValue = (v: string) => `"${v.replace(/["\\]/g, (c) => `\\${c}`)}"`;

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
  /** ISO 4217 code to convert earnings into (default: the account currency). */
  currency?: string;
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
  /** Warnings from the API (e.g. DATA_DELAYED). */
  warnings: string[];
  /** admobctl's own notes: partial recent data, default metrics left out. */
  notices: string[];
}

/**
 * The single core used by both the CLI and the MCP server.
 * Everything user-facing is resolved here: profile, auth, account, aliases.
 */
export class AdmobService {
  /** In-flight or settled lookups (account, apps, ad units, ad sources), shared by every caller. */
  private readonly cache = new Map<string, Promise<unknown>>();

  private constructor(
    readonly profile: ResolvedProfile,
    readonly client: AdmobClient,
    readonly tokenProvider: TokenProvider,
    private readonly accountOverride: string | undefined,
    readonly now: () => Date,
    /** Where config.json (and the write audit log) live. */
    readonly configDir: string,
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
    return new AdmobService(profile, client, tokenProvider, opts.account ?? profile.account, deps.now ?? (() => new Date()), dir);
  }

  /** The account that will be used (--account, then profile), without calling the API. Undefined means auto-detect. */
  get configuredAccount(): string | undefined {
    return this.accountOverride;
  }

  listAccounts(): Promise<PublisherAccount[]> {
    return this.client.listAccounts();
  }

  /**
   * Memoize a lookup for the life of the service. A failure is forgotten, so the next call retries
   * (the service may be long-lived in the MCP server).
   */
  private memo<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit) return hit as Promise<T>;
    const p = load();
    this.cache.set(key, p);
    p.catch(() => {
      if (this.cache.get(key) === p) this.cache.delete(key);
    });
    return p;
  }

  /** The active publisher account: --account, then profile, then the only accessible one. */
  account(): Promise<PublisherAccount> {
    return this.memo("account", async () => {
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
    });
  }

  apps(): Promise<AppRef[]> {
    return this.memo("apps", async () => buildAppIndex(await this.client.listApps((await this.account()).name), this.profile.aliases));
  }

  async resolveApp(input: string): Promise<AppRef> {
    return resolveApp(input, await this.apps());
  }

  private rawAdUnits(): Promise<AdUnit[]> {
    return this.memo("adUnits", async () => this.client.listAdUnits((await this.account()).name));
  }

  async adUnits(opts: { app?: string } = {}): Promise<AdUnitView[]> {
    const [apps, units] = await Promise.all([this.apps(), this.rawAdUnits()]);
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

  /** Resolve an ad unit by ad unit ID, its numeric fragment or its exact name. */
  async resolveAdUnit(input: string): Promise<AdUnit> {
    const q = input.trim();
    const units = await this.rawAdUnits();
    const exact = units.find((u) => u.adUnitId === q || u.name === q || u.adUnitId.endsWith(`/${q}`));
    if (exact) return exact;
    const byName = units.filter((u) => u.displayName.toLowerCase() === q.toLowerCase());
    if (byName.length === 1) return byName[0]!;
    if (byName.length > 1) throw usageError(`Ad unit name "${input}" is ambiguous: ${byName.map((u) => u.adUnitId).join(", ")}`);
    throw usageError(`Unknown ad unit "${input}". Run: admobctl ad-units list`);
  }

  // ── v1beta reads ──────────────────────────────────────────────────

  adSources(): Promise<AdSource[]> {
    return this.memo("adSources", async () => this.client.listAdSources((await this.account()).name));
  }

  /** Resolve an ad source by ID or title (case-insensitive). */
  async resolveAdSource(input: string): Promise<AdSource> {
    const q = input.trim().toLowerCase();
    const sources = await this.adSources();
    const hit = sources.find((s) => s.adSourceId === input.trim() || s.title.toLowerCase() === q);
    if (hit) return hit;
    throw usageError(`Unknown ad source "${input}". Ad sources: ${sources.map((s) => s.title).join(", ") || "(none)"}`);
  }

  async adapters(adSource: string): Promise<AdapterView[]> {
    const source = await this.resolveAdSource(adSource);
    const adapters = await this.client.listAdapters((await this.account()).name, source.adSourceId);
    return adapters.map((a) => ({
      adapterId: a.adapterId,
      title: a.title,
      adSource: source.title,
      adSourceId: source.adSourceId,
      platform: a.platform,
      formats: a.formats ?? [],
      settings: (a.adapterConfigMetadata ?? []).map((m) => ({
        id: m.adapterConfigMetadataId,
        label: m.adapterConfigMetadataLabel,
        required: Boolean(m.isRequired),
      })),
    }));
  }

  async mediationGroups(f: MediationGroupFilter = {}): Promise<MediationGroupView[]> {
    const parts: string[] = [];
    if (f.app) parts.push(`CONTAINS_ANY(APP_IDS, ${filterValue((await this.resolveApp(f.app)).appId)})`);
    if (f.adSource) parts.push(`CONTAINS_ANY(AD_SOURCE_IDS, ${filterValue((await this.resolveAdSource(f.adSource)).adSourceId)})`);
    // "rewarded-interstitial" → REWARDED_INTERSTITIAL, the API's enum name.
    if (f.format) parts.push(`IN(FORMAT, ${filterValue(f.format.trim().toUpperCase().replace(/-/g, "_"))})`);
    if (f.platform) parts.push(`IN(PLATFORM, ${filterValue(f.platform.toUpperCase())})`);
    if (f.state) parts.push(`IN(STATE, ${filterValue(f.state.toUpperCase())})`);
    const acct = await this.account();
    const [groups, sources, units, apps] = await Promise.all([
      this.client.listMediationGroups(acct.name, parts.join(" AND ") || undefined),
      this.adSources().catch(() => [] as AdSource[]),
      this.rawAdUnits(),
      this.apps(),
    ]);
    const sourceTitle = new Map(sources.map((s) => [s.adSourceId, s.title]));
    const unitById = new Map(units.map((u) => [u.adUnitId, u]));
    const aliasById = new Map(apps.map((a) => [a.appId, a.alias]));
    const MODE_ORDER: Record<string, number> = { LIVE: 0, MANUAL: 1 };
    return groups.map((g) => {
      const lines = Object.values(g.mediationGroupLines ?? {})
        .filter((l) => l.state !== "REMOVED")
        .map((l): MediationLineView => {
          const line: MediationLineView = {
            id: l.id,
            name: l.displayName ?? l.id,
            adSource: sourceTitle.get(l.adSourceId) ?? l.adSourceId,
            adSourceId: l.adSourceId,
            cpmMode: l.cpmMode ?? "",
            state: l.state ?? "",
            mappings: l.adUnitMappings ?? {},
          };
          if (l.cpmMode !== "LIVE" && l.cpmMicros !== undefined) {
            line.cpm_micros = Number(l.cpmMicros);
            line.cpm = line.cpm_micros / 1_000_000;
          }
          if (l.experimentVariant === "VARIANT_A") line.variant = "A";
          if (l.experimentVariant === "VARIANT_B") line.variant = "B";
          return line;
        })
        .sort((a, b) => (MODE_ORDER[a.cpmMode] ?? 2) - (MODE_ORDER[b.cpmMode] ?? 2) || (b.cpm_micros ?? 0) - (a.cpm_micros ?? 0));
      const t = g.targeting ?? {};
      const view: MediationGroupView = {
        id: g.mediationGroupId,
        name: g.displayName,
        state: g.state ?? "",
        platform: t.platform ?? "",
        format: t.format ?? "",
        adUnits: (t.adUnitIds ?? []).map((id) => {
          const u = unitById.get(id);
          return { adUnitId: id, name: u?.displayName ?? id, app: u ? (aliasById.get(u.appId) ?? u.appId) : "" };
        }),
        regions: t.targetedRegionCodes ?? [],
        excludedRegions: t.excludedRegionCodes ?? [],
        experiment: g.mediationAbExperimentState === "RUNNING" ? "running" : g.mediationAbExperimentState === "NOT_RUNNING" ? "none" : "unknown",
        lines,
        resource: g.name,
      };
      if (t.idfaTargeting && t.idfaTargeting !== "IDFA_TARGETING_UNSPECIFIED") view.idfa = t.idfaTargeting;
      return view;
    });
  }

  /** One mediation group by ID or name (case-insensitive). */
  async mediationGroup(input: string): Promise<MediationGroupView> {
    const groups = await this.mediationGroups();
    const q = input.trim().toLowerCase();
    const hit = groups.find((g) => g.id === input.trim() || g.name.toLowerCase() === q);
    if (hit) return hit;
    throw usageError(`Unknown mediation group "${input}". Groups: ${groups.map((g) => g.name).join(", ") || "(none)"}`);
  }

  async adUnitMappings(adUnit: string): Promise<AdUnitMappingView[]> {
    const unit = await this.resolveAdUnit(adUnit);
    const mappings = await this.client.listAdUnitMappings(unit.name);
    return mappings.map((m) => ({
      id: m.name.split("/").pop() ?? m.name,
      name: m.displayName ?? "",
      adUnit: unit.displayName,
      adUnitId: unit.adUnitId,
      adapterId: m.adapterId,
      state: m.state ?? "",
      settings: m.adUnitConfigurations ?? {},
      resource: m.name,
    }));
  }

  /**
   * AdMob app-promotion campaign report (v1beta). The API takes at most 30 days per request, so longer
   * ranges are fetched in chunks and added up (or concatenated when the report is by date).
   */
  async campaignReport(q: Omit<ReportQuery, "filters" | "maxRows" | "currency">): Promise<ReportResult> {
    const range = q.dateRange ?? dateRangeFromArgs(q.from ?? "", q.to ?? q.from ?? "");
    const dimensions = q.by.map((d) => normalizeDimension(d, "campaign"));
    const metrics = (q.metrics?.length ? q.metrics : DEFAULT_METRICS.campaign).map((m) => normalizeMetric(m, "campaign"));
    checkCombination(dimensions, metrics);
    const chunks = splitRange(range, CAMPAIGN_MAX_DAYS);
    const merge = chunks.length > 1 && !dimensions.includes("DATE");
    // Adding chunks up needs the bases of the ratios.
    const fetchMetrics = merge ? [...new Set([...metrics, ...metrics.flatMap((m) => RATIO_BASES[m] ?? [])])] : metrics;
    const acct = await this.account();
    const reports = await Promise.all(
      chunks.map((dateRange) => this.client.campaignReport(acct.name, { dateRange, dimensions, metrics: fetchMetrics })),
    );
    const report: Report = merge ? mergeCampaignChunks(reports, dimensions) : { rows: reports.flatMap((r) => r.rows), warnings: reports.flatMap((r) => r.warnings) };
    const truncated = reports.some((r) => r.rows.length >= API_MAX_ROWS);
    const notices = [
      "Cost and CPI are in the campaigns' reporting currency. These are AdMob app-promotion campaigns, where you are the advertiser.",
    ];
    if (chunks.length > 1) notices.push(`Campaign reports cover at most ${CAMPAIGN_MAX_DAYS} days; fetched as ${chunks.length} requests of at most ${CAMPAIGN_MAX_DAYS} days.`);
    notices.push(...freshnessNotices("campaign", range, todayIn(acct.reportingTimeZone, this.now())));
    const result: ReportResult = {
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
      notices,
    };
    if (!truncated) result.totals = computeTotals(report, metrics);
    return result;
  }

  networkReport(q: ReportQuery): Promise<ReportResult> {
    return this.report("network", q);
  }

  mediationReport(q: ReportQuery): Promise<ReportResult> {
    return this.report("mediation", q);
  }

  /** Raw report access for finance/insights, which need exact micros per row. */
  async rawReport(
    kind: StreamedReportKind,
    q: ReportQuery,
  ): Promise<{ report: Report; dimensions: string[]; metrics: string[]; range: DateRange; notices: string[] }> {
    const range = q.dateRange ?? dateRangeFromArgs(q.from ?? "", q.to ?? q.from ?? "");
    const dimensions = q.by.map((d) => normalizeDimension(d, kind));
    const notices: string[] = [];
    let metrics: string[];
    if (q.metrics?.length) metrics = q.metrics.map((m) => normalizeMetric(m, kind));
    else {
      const { kept, dropped } = compatibleMetrics(kind, dimensions, DEFAULT_METRICS[kind]);
      metrics = kept;
      if (dropped.length) {
        notices.push(`Left out ${dropped.map(friendlyMetric).join(", ")}: the AdMob API does not combine them with ${dimensions.map(friendlyName).join(", ")}.`);
      }
    }
    const filters = await this.resolveFilters(kind, q.filters ?? {});
    const spec = buildReportSpec(kind, { dateRange: range, dimensions, metrics, filters, maxRows: q.maxRows, currency: q.currency });
    const acct = await this.account();
    const report =
      kind === "network" ? await this.client.networkReport(acct.name, spec) : await this.client.mediationReport(acct.name, spec);
    notices.push(...freshnessNotices(kind, range, todayIn(acct.reportingTimeZone, this.now())));
    return { report, dimensions, metrics, range, notices };
  }

  private async resolveFilters(kind: ReportKind, filters: Record<string, string[]>): Promise<Record<string, string[]>> {
    const out: Record<string, string[]> = {};
    for (const [dim, values] of Object.entries(filters)) {
      const api = normalizeDimension(dim, kind);
      out[api] = api === "APP" ? await Promise.all(values.map(async (v) => (await this.resolveApp(v)).appId)) : values;
    }
    return out;
  }

  private async report(kind: StreamedReportKind, q: ReportQuery): Promise<ReportResult> {
    const cap = q.maxRows ?? API_MAX_ROWS;
    // The live API caps matchingRowCount at maxReportRows, so it cannot say whether rows were left out.
    // Ask for one row more than --max-rows instead: if it comes back, the report was cut short.
    const probe = cap < API_MAX_ROWS;
    const { report, dimensions, metrics, range, notices } = await this.rawReport(kind, probe ? { ...q, maxRows: cap + 1 } : q);
    const needsApps = dimensions.includes("APP");
    const apps = needsApps ? await this.apps() : [];
    const fetched = report.rows.length;
    // Without a probe, only a report that fills the API's row cap can have been cut short; matchingRowCount
    // then tells us whether it was. On its own it is not reliable ("does NOT always match the number of rows").
    const truncated = probe
      ? fetched > cap
      : fetched >= cap && (report.matchingRowCount === undefined || report.matchingRowCount > fetched);
    // A count no larger than what came back is just the cap echoed, not the real number of matching rows.
    if (truncated && report.matchingRowCount !== undefined && report.matchingRowCount <= fetched) report.matchingRowCount = undefined;
    if (fetched > cap) report.rows = report.rows.slice(0, cap);
    const acct = await this.account();
    const result: ReportResult = {
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
      notices,
    };
    if (!truncated) result.totals = computeTotals(report, metrics);
    if (report.matchingRowCount !== undefined) result.matchingRowCount = report.matchingRowCount;
    return result;
  }
}
