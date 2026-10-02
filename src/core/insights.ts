import { dateRangeFromArgs, formatDate, lastNDays, previousPeriod, todayIn, type DateRange } from "./dates.js";
import { usageError } from "./errors.js";
import { ESTIMATE_LABEL } from "./finance.js";
import { formatMicros, microsToAmount, sumMicros } from "./money.js";
import type { Report } from "./report.js";
import type { AdmobService } from "./service.js";

export const INSIGHT_DIMENSIONS = ["app", "ad-unit", "country", "format", "platform"] as const;
export type InsightDimension = (typeof INSIGHT_DIMENSIONS)[number];

export interface InsightsOptions {
  /** Number of complete days ending yesterday. Ignored when from/to are given. */
  last?: number;
  from?: string;
  to?: string;
  by: InsightDimension;
  /** Relative change that counts as a swing (default 0.3 = 30%). */
  swingThreshold?: number;
}

export interface InsightRow {
  key: string;
  label: string;
  earnings: number;
  earnings_micros: number;
  requests: number;
  matched_requests: number;
  impressions: number;
  clicks: number;
  /** Earnings per 1000 impressions. */
  ecpm: number;
  /** Earnings per 1000 ad requests. */
  request_rpm: number;
  match_rate: number;
  show_rate: number;
  ctr: number;
  /** Share of total earnings. */
  share: number;
  previous_earnings?: number;
  /** Relative change vs the previous period; absent when the previous value was 0. */
  change?: number;
}

export type HighlightKind = "top" | "bottom" | "low-fill" | "low-show-rate" | "swing-up" | "swing-down" | "new" | "gone";

export interface Highlight {
  kind: HighlightKind;
  key: string;
  label: string;
  message: string;
}

export interface InsightsResult {
  by: InsightDimension;
  from: string;
  to: string;
  currency: string;
  timeZone: string;
  estimate: true;
  totals: { earnings: number; earnings_micros: number; requests: number; impressions: number; ecpm: number; match_rate: number; show_rate: number; change?: number };
  previous: { from: string; to: string; earnings: number; earnings_micros: number };
  rows: InsightRow[];
  highlights: Highlight[];
  summary: string[];
}

interface Agg {
  key: string;
  label: string;
  earnings: number;
  requests: number;
  matched: number;
  impressions: number;
  clicks: number;
}

const DIM_API: Record<InsightDimension, string> = {
  app: "APP",
  "ad-unit": "AD_UNIT",
  country: "COUNTRY",
  format: "FORMAT",
  platform: "PLATFORM",
};

function aggregate(report: Report, dim: string, aliasOf: (id: string) => string | undefined): Map<string, Agg> {
  const out = new Map<string, Agg>();
  for (const row of report.rows) {
    const d = row.dimensions[dim];
    const key = d?.value ?? "(unknown)";
    const label = (dim === "APP" ? aliasOf(key) : undefined) ?? d?.label ?? key;
    const a = out.get(key) ?? { key, label, earnings: 0, requests: 0, matched: 0, impressions: 0, clicks: 0 };
    a.earnings += row.metrics.ESTIMATED_EARNINGS ?? 0;
    a.requests += row.metrics.AD_REQUESTS ?? 0;
    a.matched += row.metrics.MATCHED_REQUESTS ?? 0;
    a.impressions += row.metrics.IMPRESSIONS ?? 0;
    a.clicks += row.metrics.CLICKS ?? 0;
    out.set(key, a);
  }
  return out;
}

const ratio = (a: number, b: number) => (b > 0 ? a / b : 0);
const perMille = (micros: number, n: number) => microsToAmount(Math.round(ratio(micros, n) * 1000));
const pct = (f: number) => `${(f * 100).toFixed(1)}%`;
const signedPct = (f: number) => `${f >= 0 ? "+" : ""}${(f * 100).toFixed(1)}%`;

export function resolveInsightRange(opts: InsightsOptions, today: ReturnType<typeof todayIn>): DateRange {
  if (opts.from || opts.to) return dateRangeFromArgs(opts.from ?? opts.to!, opts.to ?? opts.from!);
  const days = opts.last ?? 30;
  if (!Number.isInteger(days) || days < 1 || days > 366) throw usageError("--last must be between 1d and 366d");
  return lastNDays(days, today);
}

export async function insights(svc: AdmobService, opts: InsightsOptions): Promise<InsightsResult> {
  if (!INSIGHT_DIMENSIONS.includes(opts.by)) {
    throw usageError(`--by must be one of ${INSIGHT_DIMENSIONS.join(", ")}`);
  }
  const acct = await svc.account();
  const range = resolveInsightRange(opts, todayIn(acct.reportingTimeZone, svc.now()));
  const prevRange = previousPeriod(range);
  const metrics = ["earnings", "requests", "matched-requests", "impressions", "clicks"];
  const dim = DIM_API[opts.by];
  const [cur, prev, apps] = await Promise.all([
    svc.rawReport("network", { dateRange: range, by: [opts.by], metrics }),
    svc.rawReport("network", { dateRange: prevRange, by: [opts.by], metrics }),
    opts.by === "app" ? svc.apps() : [],
  ]);
  const aliasOf = (id: string) => apps.find((a) => a.appId === id)?.alias;

  const curAgg = aggregate(cur.report, dim, aliasOf);
  const prevAgg = aggregate(prev.report, dim, aliasOf);
  const total = sumMicros([...curAgg.values()].map((a) => a.earnings));
  const prevTotal = sumMicros([...prevAgg.values()].map((a) => a.earnings));
  const totalRequests = [...curAgg.values()].reduce((s, a) => s + a.requests, 0);
  const totalMatched = [...curAgg.values()].reduce((s, a) => s + a.matched, 0);
  const totalImpressions = [...curAgg.values()].reduce((s, a) => s + a.impressions, 0);

  const rows: InsightRow[] = [...curAgg.values()]
    .sort((a, b) => b.earnings - a.earnings)
    .map((a) => {
      const p = prevAgg.get(a.key);
      const row: InsightRow = {
        key: a.key,
        label: a.label,
        earnings: microsToAmount(a.earnings),
        earnings_micros: a.earnings,
        requests: a.requests,
        matched_requests: a.matched,
        impressions: a.impressions,
        clicks: a.clicks,
        ecpm: perMille(a.earnings, a.impressions),
        request_rpm: perMille(a.earnings, a.requests),
        match_rate: ratio(a.matched, a.requests),
        show_rate: ratio(a.impressions, a.matched),
        ctr: ratio(a.clicks, a.impressions),
        share: ratio(a.earnings, total),
      };
      if (p) {
        row.previous_earnings = microsToAmount(p.earnings);
        if (p.earnings > 0) row.change = (a.earnings - p.earnings) / p.earnings;
      }
      return row;
    });

  const currency = cur.report.currency ?? acct.currencyCode;
  const money = (micros: number) => `${formatMicros(micros)} ${currency}`;
  const highlights: Highlight[] = [];
  const add = (kind: HighlightKind, r: { key: string; label: string }, message: string) =>
    highlights.push({ kind, key: r.key, label: r.label, message });

  // Top and bottom earners. With few rows, split them so nothing is both.
  const topN = Math.min(3, Math.floor(rows.length / 2) || rows.length);
  const top = rows.slice(0, topN);
  for (const r of top) {
    add("top", r, `${r.label} earned ${money(r.earnings_micros)} (${pct(r.share)} of total, eCPM ${r.ecpm.toFixed(2)}).`);
  }
  const minRequests = Math.max(1000, totalRequests * 0.05);
  const bottom = rows
    .slice(topN)
    .filter((r) => r.requests >= 1000) // ignore units with too little traffic to judge
    .reverse()
    .slice(0, 3);
  for (const r of bottom) {
    add("bottom", r, `${r.label} earned only ${money(r.earnings_micros)} from ${r.requests} requests (request RPM ${r.request_rpm.toFixed(2)}).`);
  }

  for (const r of rows) {
    if (r.requests >= minRequests && r.match_rate < 0.5) {
      add("low-fill", r, `${r.label} has low fill: ${pct(r.match_rate)} match rate on ${r.requests} requests.`);
    }
  }
  const minMatched = Math.max(1000, totalMatched * 0.05);
  for (const r of rows) {
    if (r.matched_requests >= minMatched && r.show_rate < 0.5) {
      add("low-show-rate", r, `${r.label} shows only ${pct(r.show_rate)} of matched ads (${r.impressions} of ${r.matched_requests}); check when ads are loaded vs shown.`);
    }
  }

  const threshold = opts.swingThreshold ?? 0.3;
  const minSwing = Math.max(total * 0.01, 1_000_000);
  for (const r of rows) {
    const p = prevAgg.get(r.key)?.earnings ?? 0;
    const delta = r.earnings_micros - p;
    if (Math.abs(delta) < minSwing) continue;
    if (p === 0) add("new", r, `${r.label} is new this period: ${money(r.earnings_micros)}.`);
    else if (r.change !== undefined && Math.abs(r.change) >= threshold) {
      add(r.change > 0 ? "swing-up" : "swing-down", r, `${r.label} ${r.change > 0 ? "rose" : "fell"} ${signedPct(r.change)}: ${money(p)} → ${money(r.earnings_micros)}.`);
    }
  }
  for (const p of prevAgg.values()) {
    if (!curAgg.has(p.key) && p.earnings >= minSwing) add("gone", p, `${p.label} earned ${money(p.earnings)} last period and nothing this period.`);
  }

  const change = prevTotal > 0 ? (total - prevTotal) / prevTotal : undefined;
  const from = formatDate(range.startDate);
  const to = formatDate(range.endDate);
  const summary = [
    `Estimated earnings ${money(total)} for ${from} → ${to}` +
      (change === undefined ? "." : `, ${signedPct(change)} vs the previous period (${money(prevTotal)}).`),
    `Overall eCPM ${perMille(total, totalImpressions).toFixed(2)} ${currency}, match rate ${pct(ratio(totalMatched, totalRequests))}, show rate ${pct(ratio(totalImpressions, totalMatched))}.`,
    ...highlights.filter((h) => h.kind !== "top" && h.kind !== "bottom").map((h) => h.message),
    ...highlights.filter((h) => h.kind === "top").slice(0, 1).map((h) => `Top: ${h.message}`),
    ESTIMATE_LABEL,
  ];

  const totals: InsightsResult["totals"] = {
    earnings: microsToAmount(total),
    earnings_micros: total,
    requests: totalRequests,
    impressions: totalImpressions,
    ecpm: perMille(total, totalImpressions),
    match_rate: ratio(totalMatched, totalRequests),
    show_rate: ratio(totalImpressions, totalMatched),
  };
  if (change !== undefined) totals.change = change;

  return {
    by: opts.by,
    from,
    to,
    currency,
    timeZone: cur.report.timeZone ?? acct.reportingTimeZone,
    estimate: true,
    totals,
    previous: { from: formatDate(prevRange.startDate), to: formatDate(prevRange.endDate), earnings: microsToAmount(prevTotal), earnings_micros: prevTotal },
    rows,
    highlights,
    summary,
  };
}
