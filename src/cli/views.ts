import type { AppRef } from "../core/aliases.js";
import type { Check } from "../core/auth/doctor.js";
import { JOURNAL_COLUMNS, type FinanceMonth, type FinanceRange, type JournalRow } from "../core/finance.js";
import type { InsightsResult } from "../core/insights.js";
import type { PublisherAccount } from "../core/client.js";
import { formatMicros } from "../core/money.js";
import type { ViewRow } from "../core/report-view.js";
import type { AdUnitView, ReportResult } from "../core/service.js";
import type { Column, Output } from "../output/format.js";

export const ESTIMATE_NOTE = "Estimated earnings — reconcile against AdMob Payments (finalized).";

export function accountsView(accounts: PublisherAccount[]): Output {
  return {
    data: accounts,
    table: {
      columns: [
        { key: "publisherId", label: "Publisher ID" },
        { key: "currencyCode", label: "Currency" },
        { key: "reportingTimeZone", label: "Time zone" },
      ],
      rows: accounts as unknown as Array<Record<string, unknown>>,
    },
  };
}

export function appsView(apps: AppRef[]): Output {
  return {
    data: apps,
    table: {
      columns: [
        { key: "alias", label: "Alias" },
        { key: "name", label: "Name" },
        { key: "platform", label: "Platform" },
        { key: "appId", label: "App ID" },
        { key: "storeId", label: "Store ID" },
      ],
      rows: apps as unknown as Array<Record<string, unknown>>,
    },
  };
}

export function adUnitsView(units: AdUnitView[]): Output {
  return {
    data: units,
    table: {
      columns: [
        { key: "app", label: "App" },
        { key: "name", label: "Ad unit" },
        { key: "format", label: "Format" },
        { key: "adUnitId", label: "Ad unit ID" },
      ],
      rows: units as unknown as Array<Record<string, unknown>>,
    },
  };
}

const METRIC_LABELS: Record<string, string> = {
  earnings: "Earnings",
  requests: "Requests",
  matched_requests: "Matched",
  impressions: "Impressions",
  clicks: "Clicks",
  match_rate: "Match rate",
  show_rate: "Show rate",
  ctr: "CTR",
  rpm: "RPM",
  ecpm: "eCPM",
};
const MONEY_KEYS = new Set(["earnings", "rpm", "ecpm"]);
const RATE_KEYS = new Set(["match_rate", "show_rate", "ctr"]);

const METRIC_FROM_API: Record<string, string> = {
  estimated_earnings: "earnings",
  ad_requests: "requests",
  matched_requests: "matched_requests",
  impressions: "impressions",
  clicks: "clicks",
  match_rate: "match_rate",
  show_rate: "show_rate",
  impression_ctr: "ctr",
  impression_rpm: "rpm",
  observed_ecpm: "ecpm",
};

function titleCase(key: string): string {
  const s = key.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function displayRow(row: ViewRow): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const k of Object.keys(row)) {
    if (MONEY_KEYS.has(k) && typeof row[`${k}_micros`] === "number") out[k] = formatMicros(row[`${k}_micros`] as number);
    else if (RATE_KEYS.has(k) && typeof row[k] === "number") out[k] = formatPercent(row[k] as number);
  }
  return out;
}

export function reportView(r: ReportResult): Output {
  const columns: Column[] = r.dimensions.map((d) => ({ key: d, label: d === "app" ? "App" : titleCase(d) }));
  for (const m of r.metrics) {
    const key = METRIC_FROM_API[m] ?? m;
    const label = METRIC_LABELS[key] ?? titleCase(key);
    columns.push({ key, label: MONEY_KEYS.has(key) && r.currency ? `${label} (${r.currency})` : label, align: "right" });
  }
  const notes = [`${r.kind === "network" ? "Network" : "Mediation"} report ${r.from} → ${r.to}, ${r.timeZone ?? ""}. ${ESTIMATE_NOTE}`];
  if (r.truncated) {
    notes.push(`Truncated: showing ${r.rows.length} of ${r.matchingRowCount} rows. Raise --max-rows or narrow the query.`);
  }
  for (const w of r.warnings) notes.push(`API warning: ${w}`);
  const footer = r.totals && r.rows.length > 1 ? [{ ...displayRow(r.totals), [columns[0]!.key]: "Total" }] : undefined;
  return {
    data: r,
    table: { columns, rows: r.rows.map(displayRow), footer },
    notes,
  };
}

const ICONS: Record<Check["status"], string> = { ok: "✓", warn: "!", fail: "✗", skip: "-" };

export function doctorView(checks: Check[]): Output {
  return {
    data: { ok: checks.every((c) => c.status !== "fail"), checks },
    table: {
      columns: [
        { key: "check", label: "Check" },
        { key: "summary", label: "Result" },
      ],
      rows: checks.flatMap((c) => [
        { check: `${ICONS[c.status]} ${c.id}`, summary: c.summary },
        ...(c.fix && c.status !== "ok" ? [{ check: "", summary: `→ fix: ${c.fix}` }] : []),
      ]),
    },
  };
}

export function keyValueView(data: Record<string, unknown>): Output {
  return {
    data,
    table: {
      columns: [
        { key: "key", label: "Key" },
        { key: "value", label: "Value" },
      ],
      rows: Object.entries(data).map(([key, value]) => ({
        key,
        value: typeof value === "object" && value !== null ? JSON.stringify(value) : value,
      })),
    },
  };
}

export function financeMonthView(m: FinanceMonth): Output {
  const cur = m.currency;
  return {
    data: m,
    table: {
      columns: [
        { key: "alias", label: "App" },
        { key: "name", label: "Name" },
        { key: "platform", label: "Platform" },
        { key: "earnings", label: `Earnings (${cur})`, align: "right" },
      ],
      rows: m.apps.map((a) => ({ ...a, earnings: a.earnings.toFixed(2) })),
      footer: [{ alias: "Total", earnings: m.total.toFixed(2) }],
    },
    notes: [`${m.month} (${m.from} → ${m.to}, ${m.timeZone}), booking date ${m.bookingDate}.`, ...m.notes],
  };
}

export function financeRangeView(r: FinanceRange): Output {
  return {
    data: r,
    table: {
      columns: [
        { key: "month", label: "Month" },
        { key: "total", label: `Earnings (${r.currency})`, align: "right" },
        { key: "complete", label: "Complete" },
      ],
      rows: r.months.map((m) => ({ month: m.month, total: m.total.toFixed(2), complete: m.complete ? "yes" : "no" })),
      footer: [{ month: "Total", total: r.total.toFixed(2) }],
    },
    notes: r.notes,
  };
}

export function journalView(rows: JournalRow[], notes: string[]): Output {
  return {
    data: rows,
    table: { columns: JOURNAL_COLUMNS.map((c) => ({ key: c, label: c })), rows },
    notes,
  };
}

export function insightsView(r: InsightsResult): Output {
  return {
    data: r,
    table: {
      columns: [
        { key: "label", label: r.by === "app" ? "App" : titleCase(r.by.replace(/-/g, "_")) },
        { key: "earnings", label: `Earnings (${r.currency})`, align: "right" },
        { key: "share", label: "Share", align: "right" },
        { key: "change", label: "Δ prev", align: "right" },
        { key: "ecpm", label: "eCPM", align: "right" },
        { key: "match_rate", label: "Match", align: "right" },
        { key: "show_rate", label: "Show", align: "right" },
        { key: "requests", label: "Requests", align: "right" },
      ],
      rows: r.rows.map((x) => ({
        ...x,
        earnings: x.earnings.toFixed(2),
        share: formatPercent(x.share),
        change: x.change === undefined ? "" : `${x.change >= 0 ? "+" : ""}${(x.change * 100).toFixed(1)}%`,
        ecpm: x.ecpm.toFixed(2),
        match_rate: formatPercent(x.match_rate),
        show_rate: formatPercent(x.show_rate),
      })),
      footer: [{ label: "Total", earnings: r.totals.earnings.toFixed(2), ecpm: r.totals.ecpm.toFixed(2), requests: r.totals.requests }],
    },
    notes: r.summary,
  };
}
