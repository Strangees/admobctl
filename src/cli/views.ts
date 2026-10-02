import { appsNeedingAction, approvalLabel, type AppRef } from "../core/aliases.js";
import type { ConsentResult, VersionsResult, WaterfallResult } from "../core/analyze.js";
import type { AppAdsResult } from "../core/app-ads.js";
import type { Check } from "../core/auth/doctor.js";
import { JOURNAL_COLUMNS, type FinanceMonth, type FinanceRange, type JournalRow } from "../core/finance.js";
import type { InsightsResult } from "../core/insights.js";
import type { PublisherAccount } from "../core/client.js";
import { formatMicros } from "../core/money.js";
import { shownRows, type ViewRow } from "../core/report-view.js";
import type { AdapterView, AdUnitMappingView, AdUnitView, MediationGroupView, ReportResult } from "../core/service.js";
import { API_BASE_BETA, type AdSource } from "../core/client.js";
import type { WritePlan } from "../core/write.js";
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
  const blocked = appsNeedingAction(apps);
  return {
    data: apps,
    table: {
      columns: [
        { key: "alias", label: "Alias" },
        { key: "name", label: "Name" },
        { key: "platform", label: "Platform" },
        { key: "appId", label: "App ID" },
        { key: "storeId", label: "Store ID" },
        { key: "approval", label: "Approval" },
      ],
      rows: apps.map((a) => ({ ...a, approval: approvalLabel(a.approval) })),
    },
    notes: blocked.length
      ? [`${blocked.map((a) => a.alias).join(", ")} ${blocked.length === 1 ? "needs" : "need"} action in AdMob (Apps → View all apps); ad serving may be limited until then.`]
      : undefined,
  };
}

export function appAdsView(r: AppAdsResult): Output {
  return {
    data: r,
    table: {
      columns: [
        { key: "app", label: "App" },
        { key: "status", label: "Status" },
        { key: "website", label: "Website" },
        { key: "detail", label: "Detail" },
      ],
      rows: r.apps.map((a) => ({
        app: a.app,
        status: a.status,
        website: a.website ? `${a.website} (${a.websiteSource})` : "",
        detail: a.detail,
      })),
    },
    notes: [...r.apps.flatMap((a) => a.notes.map((n) => `${a.app}: ${n}`)), ...r.summary],
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
  cost: "Cost",
  cpi: "CPI",
};
const MONEY_KEYS = new Set(["earnings", "rpm", "ecpm", "cost", "cpi"]);
const RATE_KEYS = new Set(["match_rate", "show_rate", "ctr"]);

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
  for (const key of r.metrics) {
    const label = METRIC_LABELS[key] ?? titleCase(key);
    columns.push({ key, label: MONEY_KEYS.has(key) && r.currency ? `${label} (${r.currency})` : label, align: "right" });
  }
  const notes = [`${titleCase(r.kind)} report ${r.from} → ${r.to}, ${r.timeZone ?? ""}.${r.kind === "campaign" ? "" : ` ${ESTIMATE_NOTE}`}`];
  if (r.truncated) {
    notes.push(`Truncated: ${shownRows(r)}. Raise --max-rows or narrow the query.`);
  }
  for (const w of r.warnings) notes.push(`API warning: ${w}`);
  notes.push(...r.notices);
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

const VERSION_LABELS: Record<VersionsResult["by"], string> = { sdk: "SDK version", app: "App version", os: "OS version" };

export function versionsView(r: VersionsResult): Output {
  return {
    data: r,
    table: {
      columns: [
        { key: "group", label: r.group_by === "app" ? "App" : "Platform" },
        { key: "version", label: VERSION_LABELS[r.by] },
        { key: "requests", label: "Requests", align: "right" },
        { key: "request_share", label: "Share", align: "right" },
        { key: "match_rate", label: "Match", align: "right" },
        { key: "show_rate", label: "Show", align: "right" },
        { key: "ctr", label: "CTR", align: "right" },
      ],
      rows: r.rows.map((x) => ({
        ...x,
        request_share: formatPercent(x.request_share),
        match_rate: formatPercent(x.match_rate),
        show_rate: formatPercent(x.show_rate),
        ctr: formatPercent(x.ctr),
      })),
    },
    notes: [...r.summary, ...r.notices],
  };
}

export function consentView(r: ConsentResult): Output {
  return {
    data: r,
    table: {
      columns: [
        { key: "restriction", label: "Serving restriction" },
        { key: "requests", label: "Requests", align: "right" },
        { key: "request_share", label: "Share", align: "right" },
        { key: "earnings", label: `Earnings (${r.currency})`, align: "right" },
        { key: "ecpm", label: "eCPM", align: "right" },
        { key: "ecpm_vs_unrestricted", label: "vs open", align: "right" },
        { key: "match_rate", label: "Match", align: "right" },
        { key: "show_rate", label: "Show", align: "right" },
      ],
      rows: r.rows.map((x) => ({
        ...x,
        request_share: formatPercent(x.request_share),
        earnings: x.earnings.toFixed(2),
        ecpm: x.ecpm.toFixed(2),
        ecpm_vs_unrestricted: x.ecpm_vs_unrestricted === undefined ? "" : formatPercent(x.ecpm_vs_unrestricted),
        match_rate: formatPercent(x.match_rate),
        show_rate: formatPercent(x.show_rate),
      })),
    },
    notes: [...r.summary, ...r.notices],
  };
}

export function waterfallView(r: WaterfallResult): Output {
  return {
    data: r,
    table: {
      columns: [
        { key: "group", label: "Mediation group" },
        { key: "source", label: "Ad source" },
        { key: "instance", label: "Instance" },
        { key: "ecpm", label: `Obs. eCPM (${r.currency})`, align: "right" },
        { key: "earnings", label: `Earnings (${r.currency})`, align: "right" },
        { key: "earnings_share", label: "Share", align: "right" },
        { key: "requests", label: "Requests", align: "right" },
        { key: "match_rate", label: "Match", align: "right" },
        { key: "impressions", label: "Impressions", align: "right" },
      ],
      rows: r.rows.map((x) => ({
        ...x,
        ecpm: formatMicros(x.ecpm_micros),
        earnings: formatMicros(x.earnings_micros),
        earnings_share: formatPercent(x.earnings_share),
        match_rate: formatPercent(x.match_rate),
      })),
    },
    notes: [...r.summary, ...r.notices],
  };
}

export function adSourcesView(sources: AdSource[]): Output {
  return {
    data: sources,
    table: {
      columns: [
        { key: "title", label: "Ad source" },
        { key: "adSourceId", label: "Ad source ID" },
      ],
      rows: sources as unknown as Array<Record<string, unknown>>,
    },
  };
}

export function adaptersView(adapters: AdapterView[]): Output {
  return {
    data: adapters,
    table: {
      columns: [
        { key: "title", label: "Adapter" },
        { key: "adapterId", label: "Adapter ID" },
        { key: "platform", label: "Platform" },
        { key: "formats", label: "Formats" },
        { key: "settings", label: "Mapping settings (* required)" },
      ],
      rows: adapters.map((a) => ({ ...a, settings: a.settings.map((x) => `${x.label}${x.required ? "*" : ""}`).join(", ") })),
    },
  };
}

export function mediationGroupsView(groups: MediationGroupView[]): Output {
  return {
    data: groups,
    table: {
      columns: [
        { key: "name", label: "Mediation group" },
        { key: "id", label: "ID" },
        { key: "state", label: "State" },
        { key: "platform", label: "Platform" },
        { key: "format", label: "Format" },
        { key: "adUnits", label: "Ad units", align: "right" },
        { key: "lines", label: "Lines", align: "right" },
        { key: "experiment", label: "A/B test" },
      ],
      rows: groups.map((g) => ({ ...g, adUnits: g.adUnits.length, lines: g.lines.length })),
    },
  };
}

export function mediationGroupView(g: MediationGroupView): Output {
  const notes = [
    `${g.name} (${g.id}): ${g.state}, ${g.platform} ${g.format}, A/B test ${g.experiment}.`,
    `Ad units: ${g.adUnits.map((u) => (u.app ? `${u.name} (${u.app})` : u.name)).join(", ") || "(none)"}.`,
    `Regions: ${g.regions.join(", ") || "all"}${g.excludedRegions.length ? `; excluding ${g.excludedRegions.join(", ")}` : ""}.`,
  ];
  if (g.lines.some((l) => l.cpm !== undefined)) notes.push("Manual CPMs are in USD, the only currency the API supports for mediation lines.");
  return {
    data: g,
    table: {
      columns: [
        { key: "name", label: "Line" },
        { key: "adSource", label: "Ad source" },
        { key: "cpmMode", label: "CPM mode" },
        { key: "cpm", label: "CPM (USD)", align: "right" },
        { key: "state", label: "State" },
        { key: "variant", label: "Variant" },
        { key: "id", label: "Line ID" },
      ],
      rows: g.lines.map((l) => ({ ...l, cpm: l.cpm_micros === undefined ? "" : formatMicros(l.cpm_micros) })),
    },
    notes,
  };
}

export function mappingsView(mappings: AdUnitMappingView[]): Output {
  return {
    data: mappings,
    table: {
      columns: [
        { key: "name", label: "Mapping" },
        { key: "id", label: "ID" },
        { key: "adapterId", label: "Adapter ID" },
        { key: "state", label: "State" },
        { key: "settings", label: "Settings" },
      ],
      rows: mappings.map((m) => ({ ...m, settings: Object.entries(m.settings).map(([k, v]) => `${k}=${v}`).join(", ") })),
    },
  };
}

function requestLine(p: WritePlan): string {
  // Shown unencoded so the update mask stays readable; the request itself is encoded.
  const qs = p.query ? `?${Object.entries(p.query).map(([k, v]) => `${k}=${v}`).join("&")}` : "";
  return `${p.method} ${API_BASE_BETA}/${p.path}${qs}`;
}

/** A write's plan (dry run) or, once applied, the plan plus what the API returned. */
export function writeView(plans: WritePlan[], results?: unknown[]): Output {
  const applied = results !== undefined;
  const rows = plans.flatMap((p, i) =>
    p.summary.map((line, j) => ({
      step: j === 0 ? `${i + 1}. ${p.action}` : "",
      change: line,
      result: j === 0 && applied ? String((results![i] as { name?: unknown } | undefined)?.name ?? "done") : "",
    })),
  );
  const columns: Column[] = [
    { key: "step", label: "Step" },
    { key: "change", label: "Change" },
  ];
  if (applied) columns.push({ key: "result", label: "Result" });
  return {
    data: applied ? { applied: true, plans, results } : { applied: false, plans },
    table: { columns, rows },
    notes: applied ? [] : plans.flatMap((p) => [requestLine(p), JSON.stringify(p.body, null, 2)]),
  };
}
