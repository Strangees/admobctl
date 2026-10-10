import type { DateRange } from "./dates.js";
import { usageError } from "./errors.js";
import { parseMicros } from "./money.js";

export type ReportKind = "network" | "mediation" | "campaign";

export const DIMENSIONS: Record<ReportKind, readonly string[]> = {
  network: [
    "DATE", "MONTH", "WEEK", "AD_UNIT", "APP", "AD_TYPE", "COUNTRY", "FORMAT", "PLATFORM",
    "MOBILE_OS_VERSION", "GMA_SDK_VERSION", "APP_VERSION_NAME", "SERVING_RESTRICTION",
  ],
  mediation: [
    "DATE", "MONTH", "WEEK", "AD_SOURCE", "AD_SOURCE_INSTANCE", "AD_UNIT", "APP", "MEDIATION_GROUP",
    "COUNTRY", "FORMAT", "PLATFORM", "MOBILE_OS_VERSION", "GMA_SDK_VERSION", "APP_VERSION_NAME",
    "SERVING_RESTRICTION",
  ],
  // v1beta campaignReport: AdMob app-promotion campaigns (the publisher as advertiser).
  campaign: [
    "DATE", "CAMPAIGN_ID", "CAMPAIGN_NAME", "AD_ID", "AD_NAME", "PLACEMENT_ID", "PLACEMENT_NAME", "PLACEMENT_PLATFORM",
    "COUNTRY", "FORMAT",
  ],
};

export const METRICS: Record<ReportKind, readonly string[]> = {
  network: [
    "AD_REQUESTS", "CLICKS", "ESTIMATED_EARNINGS", "IMPRESSIONS", "IMPRESSION_CTR", "IMPRESSION_RPM",
    "MATCHED_REQUESTS", "MATCH_RATE", "SHOW_RATE",
  ],
  mediation: [
    "AD_REQUESTS", "CLICKS", "ESTIMATED_EARNINGS", "IMPRESSIONS", "IMPRESSION_CTR", "MATCHED_REQUESTS",
    "MATCH_RATE", "OBSERVED_ECPM",
  ],
  campaign: ["IMPRESSIONS", "CLICKS", "CLICK_THROUGH_RATE", "INSTALLS", "ESTIMATED_COST", "AVERAGE_CPI", "INTERACTIONS"],
};

/** Metrics the API returns as `microsValue` (money). */
export const MONEY_METRICS = new Set(["ESTIMATED_EARNINGS", "IMPRESSION_RPM", "OBSERVED_ECPM", "ESTIMATED_COST", "AVERAGE_CPI"]);
/** Metrics that are ratios in [0, 1]. */
export const RATE_METRICS = new Set(["MATCH_RATE", "SHOW_RATE", "IMPRESSION_CTR", "CLICK_THROUGH_RATE"]);

const METRIC_ALIASES: Record<string, string> = {
  EARNINGS: "ESTIMATED_EARNINGS",
  REVENUE: "ESTIMATED_EARNINGS",
  REQUESTS: "AD_REQUESTS",
  MATCHED: "MATCHED_REQUESTS",
  CTR: "IMPRESSION_CTR",
  RPM: "IMPRESSION_RPM",
  ECPM: "OBSERVED_ECPM",
  COST: "ESTIMATED_COST",
  CPI: "AVERAGE_CPI",
};

/** Aliases that mean something else in one report type. */
const KIND_METRIC_ALIASES: Partial<Record<ReportKind, Record<string, string>>> = {
  campaign: { CTR: "CLICK_THROUGH_RATE" },
};

const DIMENSION_ALIASES: Record<string, string> = {
  UNIT: "AD_UNIT",
  SOURCE: "AD_SOURCE",
  OS_VERSION: "MOBILE_OS_VERSION",
  SDK_VERSION: "GMA_SDK_VERSION",
  APP_VERSION: "APP_VERSION_NAME",
  CAMPAIGN: "CAMPAIGN_NAME",
  AD: "AD_NAME",
  PLACEMENT: "PLACEMENT_NAME",
};

function canonical(name: string): string {
  return name.trim().toUpperCase().replace(/-/g, "_");
}

export function friendlyName(apiName: string): string {
  return apiName.toLowerCase().replace(/_/g, "-");
}

/** The short name users type for an API metric, e.g. AD_REQUESTS → requests. */
export function friendlyMetric(apiName: string): string {
  const alias = Object.keys(METRIC_ALIASES).find((k) => METRIC_ALIASES[k] === apiName);
  return friendlyName(alias ?? apiName);
}

export function normalizeDimension(name: string, kind: ReportKind): string {
  const c = canonical(name);
  const resolved = DIMENSION_ALIASES[c] ?? c;
  if (!DIMENSIONS[kind].includes(resolved)) {
    throw usageError(
      `Dimension "${name}" is not supported by ${kind} reports. Valid: ${DIMENSIONS[kind].map(friendlyName).join(", ")}`,
    );
  }
  return resolved;
}

export function normalizeMetric(name: string, kind: ReportKind): string {
  const c = canonical(name);
  const resolved = KIND_METRIC_ALIASES[kind]?.[c] ?? METRIC_ALIASES[c] ?? c;
  if (!METRICS[kind].includes(resolved)) {
    throw usageError(
      `Metric "${name}" is not supported by ${kind} reports. Valid: ${METRICS[kind].map(friendlyName).join(", ")}`,
    );
  }
  return resolved;
}

export interface ReportSpecInput {
  dateRange: DateRange;
  dimensions: string[];
  metrics: string[];
  /** dimension → allowed values */
  filters?: Record<string, string[]>;
  maxRows?: number;
  /** ISO 4217 code; the API converts earnings at the daily average rate. */
  currency?: string;
  /** `<field>[:asc|desc]`, a dimension or metric of this report. Default: by time, else by earnings. */
  sort?: string;
}

export type SortCondition = { dimension?: string; metric?: string; order: "ASCENDING" | "DESCENDING" };

export interface ReportSpec {
  dateRange: DateRange;
  dimensions: string[];
  metrics: string[];
  dimensionFilters?: Array<{ dimension: string; matchesAny: { values: string[] } }>;
  sortConditions?: SortCondition[];
  localizationSettings?: { currencyCode: string };
  maxReportRows?: number;
}

/** The API's own maximum for maxReportRows. */
export const API_MAX_ROWS = 100_000;

/** True when a report fetched without a row cap filled the API's maximum, so rows were probably left out. */
export const hitRowCap = (report: Report) => report.rows.length >= API_MAX_ROWS;

/** The note for analyses, which fetch without a row cap and add rows up. */
export function rowCapNotices(...reports: Report[]): string[] {
  return reports.some(hitRowCap)
    ? [`The AdMob API returned its maximum of ${API_MAX_ROWS} rows, so some rows are probably missing and totals are too low. Use a shorter range.`]
    : [];
}

export const TIME_DIMENSIONS = ["DATE", "WEEK", "MONTH"];

/** Combinations the API rejects (both the reference and the metrics guide agree). */
const INCOMPATIBLE: Record<string, readonly string[]> = {
  AD_TYPE: ["AD_REQUESTS", "MATCH_RATE", "IMPRESSION_RPM"],
};

/**
 * Combinations the 2025 metrics guide calls incompatible but the newer reference no longer mentions.
 * We leave these out of default metrics but still send them when asked for explicitly.
 */
const DISCOURAGED: Record<string, readonly string[]> = {
  MOBILE_OS_VERSION: ["ESTIMATED_EARNINGS", "OBSERVED_ECPM", "IMPRESSION_RPM"],
  GMA_SDK_VERSION: ["ESTIMATED_EARNINGS", "OBSERVED_ECPM", "IMPRESSION_RPM"],
  APP_VERSION_NAME: ["ESTIMATED_EARNINGS", "OBSERVED_ECPM", "IMPRESSION_RPM"],
};

/** Split (API-named) default metrics into those that work with the dimensions and those to leave out. */
export function compatibleMetrics(_kind: ReportKind, dimensions: string[], metrics: string[]): { kept: string[]; dropped: string[] } {
  const excluded = new Set(dimensions.flatMap((d) => [...(INCOMPATIBLE[d] ?? []), ...(DISCOURAGED[d] ?? [])]));
  return { kept: metrics.filter((m) => !excluded.has(m)), dropped: metrics.filter((m) => excluded.has(m)) };
}

export function checkCombination(dimensions: string[], metrics: string[]): void {
  const timeDims = dimensions.filter((d) => TIME_DIMENSIONS.includes(d));
  if (timeDims.length > 1) {
    throw usageError(`A report can use only one time dimension (date, week or month), got ${timeDims.map(friendlyName).join(", ")}.`);
  }
  for (const d of dimensions) {
    const bad = metrics.filter((m) => INCOMPATIBLE[d]?.includes(m));
    if (bad.length) {
      throw usageError(`${friendlyName(d)} cannot be combined with ${bad.map(friendlyMetric).join(", ")} (an AdMob API restriction). Drop one of them.`);
    }
  }
}

export function normalizeCurrency(code: string): string {
  const c = code.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) throw usageError(`Currency must be an ISO 4217 code like USD or EUR, got "${code}"`);
  return c;
}

/**
 * `--sort <field>[:asc|desc]`. The field is one of the report's own (API-named) dimensions or metrics;
 * dimensions ascend and metrics descend unless an order is given.
 */
export function parseSort(input: string, kind: ReportKind, dimensions: string[], metrics: string[]): SortCondition {
  const [field = "", dir, ...rest] = input.split(":").map((p) => p.trim());
  const order = dir?.toLowerCase();
  if (rest.length || (order !== undefined && order !== "asc" && order !== "desc")) {
    throw usageError(`--sort expects <field>[:asc|desc] with asc or desc, got "${input}"`);
  }
  const named = <T>(resolve: () => T): T | undefined => {
    try {
      return resolve();
    } catch {
      return undefined;
    }
  };
  const dimension = named(() => normalizeDimension(field, kind));
  if (dimension && dimensions.includes(dimension)) return { dimension, order: order === "desc" ? "DESCENDING" : "ASCENDING" };
  const metric = named(() => normalizeMetric(field, kind));
  if (metric && metrics.includes(metric)) return { metric, order: order === "asc" ? "ASCENDING" : "DESCENDING" };
  throw usageError(
    `Cannot sort by "${field}": it is not in this report. Sort by one of: ${[...dimensions.map(friendlyName), ...metrics.map(friendlyMetric)].join(", ")}`,
  );
}

export function buildReportSpec(kind: ReportKind, input: ReportSpecInput): ReportSpec {
  const dimensions = input.dimensions.map((d) => normalizeDimension(d, kind));
  const metrics = input.metrics.map((m) => normalizeMetric(m, kind));
  checkCombination(dimensions, metrics);
  const spec: ReportSpec = { dateRange: input.dateRange, dimensions, metrics };

  const filters = Object.entries(input.filters ?? {});
  if (filters.length) {
    spec.dimensionFilters = filters.map(([dim, values]) => ({
      dimension: normalizeDimension(dim, kind),
      matchesAny: { values },
    }));
  }

  const timeDim = dimensions.find((d) => TIME_DIMENSIONS.includes(d));
  if (input.sort !== undefined) spec.sortConditions = [parseSort(input.sort, kind, dimensions, metrics)];
  else if (timeDim) spec.sortConditions = [{ dimension: timeDim, order: "ASCENDING" }];
  else if (metrics.includes("ESTIMATED_EARNINGS")) {
    spec.sortConditions = [{ metric: "ESTIMATED_EARNINGS", order: "DESCENDING" }];
  }

  if (input.currency !== undefined) spec.localizationSettings = { currencyCode: normalizeCurrency(input.currency) };
  if (input.maxRows !== undefined) spec.maxReportRows = input.maxRows;
  return spec;
}

export interface DimensionValue {
  value: string;
  label?: string;
}

export interface ReportRow {
  dimensions: Record<string, DimensionValue>;
  /** Money metrics are integer micros; counts are integers; rates are fractions. */
  metrics: Record<string, number>;
}

export interface Report {
  currency?: string;
  timeZone?: string;
  dateRange?: DateRange;
  rows: ReportRow[];
  matchingRowCount?: number;
  warnings: string[];
}

interface RawMetricValue {
  microsValue?: string;
  integerValue?: string;
  doubleValue?: number;
}

interface RawChunk {
  header?: {
    dateRange?: DateRange;
    localizationSettings?: { currencyCode?: string };
    reportingTimeZone?: string;
  };
  row?: {
    dimensionValues?: Record<string, { value?: string; displayLabel?: string }>;
    metricValues?: Record<string, RawMetricValue>;
  };
  footer?: {
    matchingRowCount?: string;
    warnings?: Array<{ type?: string; description?: string }>;
  };
}

function metricNumber(key: string, v: RawMetricValue): number {
  if (v.microsValue !== undefined) return parseMicros(v.microsValue);
  if (v.integerValue !== undefined) return Number(v.integerValue);
  // The live API sends IMPRESSION_RPM as a doubleValue in currency units (125.35), not micros.
  if (MONEY_METRICS.has(key) && v.doubleValue !== undefined) return Math.round(v.doubleValue * 1_000_000);
  return v.doubleValue ?? 0;
}

/**
 * Parse a report response: the streamed JSON array of networkReport/mediationReport:generate
 * (header, rows, footer), or campaignReport:generate's single `{ rows: [...] }` object.
 */
export function parseReport(raw: unknown): Report {
  const rows = (raw as { rows?: RawChunk["row"][] } | undefined)?.rows;
  const chunks: RawChunk[] = Array.isArray(raw) ? raw : Array.isArray(rows) ? rows.map((row) => ({ row })) : [raw as RawChunk];
  const report: Report = { rows: [], warnings: [] };
  for (const chunk of chunks) {
    if (chunk.header) {
      report.currency = chunk.header.localizationSettings?.currencyCode;
      report.timeZone = chunk.header.reportingTimeZone;
      report.dateRange = chunk.header.dateRange;
    }
    if (chunk.row) {
      const dimensions: Record<string, DimensionValue> = {};
      for (const [k, v] of Object.entries(chunk.row.dimensionValues ?? {})) {
        dimensions[k] = v.displayLabel === undefined ? { value: v.value ?? "" } : { value: v.value ?? "", label: v.displayLabel };
      }
      const metrics: Record<string, number> = {};
      for (const [k, v] of Object.entries(chunk.row.metricValues ?? {})) metrics[k] = metricNumber(k, v);
      report.rows.push({ dimensions, metrics });
    }
    if (chunk.footer) {
      if (chunk.footer.matchingRowCount !== undefined) report.matchingRowCount = Number(chunk.footer.matchingRowCount);
      for (const w of chunk.footer.warnings ?? []) report.warnings.push(w.description ?? w.type ?? "unknown warning");
    }
  }
  return report;
}
