import type { AppRef } from "./aliases.js";
import { microsToAmount, sumMicros } from "./money.js";
import { friendlyName, MONEY_METRICS, type Report } from "./report.js";

export type ViewRow = Record<string, string | number>;

/** API metric → friendly JSON key. */
export const METRIC_KEYS: Record<string, string> = {
  ESTIMATED_EARNINGS: "earnings",
  AD_REQUESTS: "requests",
  MATCHED_REQUESTS: "matched_requests",
  IMPRESSIONS: "impressions",
  CLICKS: "clicks",
  MATCH_RATE: "match_rate",
  SHOW_RATE: "show_rate",
  IMPRESSION_CTR: "ctr",
  IMPRESSION_RPM: "rpm",
  OBSERVED_ECPM: "ecpm",
  CLICK_THROUGH_RATE: "ctr",
  ESTIMATED_COST: "cost",
  AVERAGE_CPI: "cpi",
};

/** Row key for an API metric, as used in `rows`, `totals` and `ReportResult.metrics`. */
export function metricKey(metric: string): string {
  return METRIC_KEYS[metric] ?? metric.toLowerCase();
}

/** Row key for an API dimension, as used in `rows` and `ReportResult.dimensions`. */
export function dimensionKey(dim: string): string {
  return friendlyName(dim).replace(/-/g, "_");
}

function formatDimensionDate(dim: string, value: string): string {
  if ((dim === "DATE" || dim === "WEEK") && /^\d{8}$/.test(value)) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  }
  if (dim === "MONTH" && /^\d{6}$/.test(value)) return `${value.slice(0, 4)}-${value.slice(4, 6)}`;
  return value;
}

/** Flatten an API report row into friendly keys. Money becomes a rounded amount plus exact micros. */
export function toViewRows(report: Report, dimensions: string[], metrics: string[], apps: AppRef[] = []): ViewRow[] {
  const byAppId = new Map(apps.map((a) => [a.appId, a]));
  return report.rows.map((row) => {
    const out: ViewRow = {};
    for (const dim of dimensions) {
      const v = row.dimensions[dim];
      if (!v) continue;
      const key = dimensionKey(dim);
      if (dim === "APP") {
        const app = byAppId.get(v.value);
        out.app = app?.alias ?? v.label ?? v.value;
        out.app_name = app?.name ?? v.label ?? v.value;
        out.app_id = v.value;
      } else if (v.label !== undefined && v.label !== v.value) {
        out[key] = v.label;
        out[`${key}_id`] = v.value;
      } else {
        out[key] = formatDimensionDate(dim, v.value);
      }
    }
    for (const m of metrics) {
      const key = metricKey(m);
      const value = row.metrics[m] ?? 0;
      if (MONEY_METRICS.has(m)) {
        out[key] = microsToAmount(value);
        out[`${key}_micros`] = value;
      } else out[key] = value;
    }
    return out;
  });
}

/** Totals over the rows; ratios are recomputed from the summed counts, never averaged. */
export function computeTotals(report: Report, metrics: string[]): ViewRow {
  const sum = (m: string) => sumMicros(report.rows.map((r) => r.metrics[m] ?? 0));
  const has = (m: string) => metrics.includes(m);
  const t: ViewRow = {};
  const earnings = sum("ESTIMATED_EARNINGS");
  const requests = sum("AD_REQUESTS");
  const matched = sum("MATCHED_REQUESTS");
  const impressions = sum("IMPRESSIONS");
  const clicks = sum("CLICKS");
  if (has("ESTIMATED_EARNINGS")) {
    t.earnings = microsToAmount(earnings);
    t.earnings_micros = earnings;
  }
  if (has("AD_REQUESTS")) t.requests = requests;
  if (has("MATCHED_REQUESTS")) t.matched_requests = matched;
  if (has("IMPRESSIONS")) t.impressions = impressions;
  if (has("CLICKS")) t.clicks = clicks;
  const ratio = (a: number, b: number) => (b ? a / b : 0);
  if (has("MATCH_RATE") && has("AD_REQUESTS") && has("MATCHED_REQUESTS")) t.match_rate = ratio(matched, requests);
  if (has("SHOW_RATE") && has("MATCHED_REQUESTS") && has("IMPRESSIONS")) t.show_rate = ratio(impressions, matched);
  if (has("IMPRESSION_CTR") && has("CLICKS") && has("IMPRESSIONS")) t.ctr = ratio(clicks, impressions);
  if (has("IMPRESSION_RPM") && has("IMPRESSIONS") && has("ESTIMATED_EARNINGS")) {
    t.rpm = microsToAmount(Math.round(ratio(earnings, impressions) * 1000));
  }
  if (has("OBSERVED_ECPM") && has("IMPRESSIONS") && has("ESTIMATED_EARNINGS")) {
    t.ecpm = microsToAmount(Math.round(ratio(earnings, impressions) * 1000));
  }
  // Campaign reports.
  const installs = sum("INSTALLS");
  const cost = sum("ESTIMATED_COST");
  if (has("INSTALLS")) t.installs = installs;
  if (has("INTERACTIONS")) t.interactions = sum("INTERACTIONS");
  if (has("ESTIMATED_COST")) {
    t.cost = microsToAmount(cost);
    t.cost_micros = cost;
  }
  if (has("CLICK_THROUGH_RATE") && has("CLICKS") && has("IMPRESSIONS")) t.ctr = ratio(clicks, impressions);
  if (has("AVERAGE_CPI") && has("ESTIMATED_COST") && has("INSTALLS")) t.cpi = microsToAmount(Math.round(ratio(cost, installs)));
  return t;
}

/** "showing N of M rows", or "showing N rows; more may exist" when the API gave no matching count. */
export function shownRows(r: { rows: unknown[]; matchingRowCount?: number }): string {
  return r.matchingRowCount !== undefined
    ? `showing ${r.rows.length} of ${r.matchingRowCount} rows`
    : `showing ${r.rows.length} rows; more may exist`;
}
