import type { DateRange } from "./dates.js";
import { usageError } from "./errors.js";
import { parseMicros } from "./money.js";

export type ReportKind = "network" | "mediation";

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
};

/** Metrics the API returns as `microsValue` (money). */
export const MONEY_METRICS = new Set(["ESTIMATED_EARNINGS", "IMPRESSION_RPM", "OBSERVED_ECPM"]);
/** Metrics that are ratios in [0, 1]. */
export const RATE_METRICS = new Set(["MATCH_RATE", "SHOW_RATE", "IMPRESSION_CTR"]);

const METRIC_ALIASES: Record<string, string> = {
  EARNINGS: "ESTIMATED_EARNINGS",
  REVENUE: "ESTIMATED_EARNINGS",
  REQUESTS: "AD_REQUESTS",
  MATCHED: "MATCHED_REQUESTS",
  CTR: "IMPRESSION_CTR",
  RPM: "IMPRESSION_RPM",
  ECPM: "OBSERVED_ECPM",
};

const DIMENSION_ALIASES: Record<string, string> = {
  UNIT: "AD_UNIT",
  SOURCE: "AD_SOURCE",
  OS_VERSION: "MOBILE_OS_VERSION",
  SDK_VERSION: "GMA_SDK_VERSION",
  APP_VERSION: "APP_VERSION_NAME",
};

function canonical(name: string): string {
  return name.trim().toUpperCase().replace(/-/g, "_");
}

export function friendlyName(apiName: string): string {
  return apiName.toLowerCase().replace(/_/g, "-");
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
  const resolved = METRIC_ALIASES[c] ?? c;
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
}

export interface ReportSpec {
  dateRange: DateRange;
  dimensions: string[];
  metrics: string[];
  dimensionFilters?: Array<{ dimension: string; matchesAny: { values: string[] } }>;
  sortConditions?: Array<{ dimension?: string; metric?: string; order: "ASCENDING" | "DESCENDING" }>;
  maxReportRows?: number;
}

const TIME_DIMENSIONS = ["DATE", "WEEK", "MONTH"];

export function buildReportSpec(kind: ReportKind, input: ReportSpecInput): ReportSpec {
  const dimensions = input.dimensions.map((d) => normalizeDimension(d, kind));
  const metrics = input.metrics.map((m) => normalizeMetric(m, kind));
  const spec: ReportSpec = { dateRange: input.dateRange, dimensions, metrics };

  const filters = Object.entries(input.filters ?? {});
  if (filters.length) {
    spec.dimensionFilters = filters.map(([dim, values]) => ({
      dimension: normalizeDimension(dim, kind),
      matchesAny: { values },
    }));
  }

  const timeDim = dimensions.find((d) => TIME_DIMENSIONS.includes(d));
  if (timeDim) spec.sortConditions = [{ dimension: timeDim, order: "ASCENDING" }];
  else if (metrics.includes("ESTIMATED_EARNINGS")) {
    spec.sortConditions = [{ metric: "ESTIMATED_EARNINGS", order: "DESCENDING" }];
  }

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

function metricNumber(v: RawMetricValue): number {
  if (v.microsValue !== undefined) return parseMicros(v.microsValue);
  if (v.integerValue !== undefined) return Number(v.integerValue);
  return v.doubleValue ?? 0;
}

/** Parse the JSON array returned by networkReport/mediationReport:generate. */
export function parseReport(raw: unknown): Report {
  const chunks: RawChunk[] = Array.isArray(raw) ? raw : [raw as RawChunk];
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
      for (const [k, v] of Object.entries(chunk.row.metricValues ?? {})) metrics[k] = metricNumber(v);
      report.rows.push({ dimensions, metrics });
    }
    if (chunk.footer) {
      if (chunk.footer.matchingRowCount !== undefined) report.matchingRowCount = Number(chunk.footer.matchingRowCount);
      for (const w of chunk.footer.warnings ?? []) report.warnings.push(w.description ?? w.type ?? "unknown warning");
    }
  }
  return report;
}
