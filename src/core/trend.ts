import type { AppRef } from "./aliases.js";
import { fetchReport, type AnalyzeRange, type Base, type Finding } from "./analyze.js";
import { addDays, compareDates, formatDate, type ApiDate } from "./dates.js";
import { usageError } from "./errors.js";
import { ESTIMATE_LABEL } from "./finance.js";
import { checkRangeArgs, perMille, ratio, signedPct } from "./insights.js";
import { formatMicros, microsToAmount } from "./money.js";
import type { AdmobService } from "./service.js";

/** Daily series: when did a change start, and is there a weekday pattern? */

export const TREND_SPLITS = ["total", "app", "format", "country", "platform"] as const;
export type TrendSplit = (typeof TREND_SPLITS)[number];

const SPLIT_DIM: Record<Exclude<TrendSplit, "total">, string> = { app: "APP", format: "FORMAT", country: "COUNTRY", platform: "PLATFORM" };
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
/** Series kept when splitting (by earnings). */
export const MAX_SERIES = 10;

export interface TrendOptions extends AnalyzeRange {
  by?: TrendSplit;
  app?: string;
  currency?: string;
  /** Include each series' daily rows (default true). */
  days?: boolean;
}

export interface TrendDay {
  date: string;
  weekday: (typeof WEEKDAYS)[number];
  earnings: number;
  earnings_micros: number;
  requests: number;
  impressions: number;
  match_rate: number;
  show_rate: number;
  ecpm: number;
}

export interface TrendSeries {
  key: string;
  label: string;
  earnings: number;
  earnings_micros: number;
  /** First day with ad requests in the range; earlier days are left out of every average. */
  first_active?: string;
  /** Days from first_active to the end of the range, silent days included. */
  active_days: number;
  average_per_day: number;
  /** Average earnings per weekday, Monday first. */
  weekdays: Array<{ weekday: (typeof WEEKDAYS)[number]; days: number; average: number }>;
  /** The day daily earnings moved to a new level, when the series has one clear step. */
  shift?: { date: string; before_per_day: number; after_per_day: number; change: number };
  days?: TrendDay[];
}

export interface TrendResult extends Base {
  by: TrendSplit;
  currency: string;
  estimate: true;
  rows: TrendSeries[];
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const squares = (xs: number[], m: number) => xs.reduce((a, x) => a + (x - m) ** 2, 0);

/**
 * The single split that best divides a series into two levels, or undefined when no split explains at least
 * half of the series' variance with a change of at least 20%. Each side needs three days.
 */
export function levelShift(values: number[]): { index: number; before: number; after: number } | undefined {
  const MIN_SIDE = 3;
  if (values.length < 2 * MIN_SIDE + 1) return undefined;
  const total = squares(values, mean(values));
  if (total === 0) return undefined;
  let best: { index: number; before: number; after: number; left: number } | undefined;
  for (let i = MIN_SIDE; i <= values.length - MIN_SIDE; i++) {
    const before = mean(values.slice(0, i));
    const after = mean(values.slice(i));
    const left = squares(values.slice(0, i), before) + squares(values.slice(i), after);
    if (!best || left < best.left) best = { index: i, before, after, left };
  }
  if (!best || best.before <= 0) return undefined;
  if ((total - best.left) / total < 0.5 || Math.abs(best.after - best.before) / best.before < 0.2) return undefined;
  return { index: best.index, before: best.before, after: best.after };
}

const weekdayOf = (d: ApiDate) => WEEKDAYS[(new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay() + 6) % 7]!;

interface DaySums {
  earnings: number;
  requests: number;
  matched: number;
  impressions: number;
}

export async function analyzeTrend(svc: AdmobService, opts: TrendOptions = {}): Promise<TrendResult> {
  const by = opts.by ?? "total";
  if (!TREND_SPLITS.includes(by)) throw usageError(`--by must be one of ${TREND_SPLITS.join(", ")}`);
  checkRangeArgs(opts);
  const dim = by === "total" ? undefined : SPLIT_DIM[by];
  const [r, apps] = await Promise.all([
    fetchReport(svc, "network", {
      ...opts,
      by: dim ? ["DATE", dim] : ["DATE"],
      metrics: ["ESTIMATED_EARNINGS", "AD_REQUESTS", "MATCHED_REQUESTS", "IMPRESSIONS"],
      filters: opts.app ? { app: [opts.app] } : undefined,
    }),
    by === "app" ? svc.apps() : Promise.resolve([] as AppRef[]),
  ]);
  const alias = new Map(apps.map((a) => [a.appId, a.alias]));
  const totalLabel = opts.app ? (await svc.resolveApp(opts.app)).alias : "All apps";

  const bySeries = new Map<string, { label: string; days: Map<string, DaySums> }>();
  for (const row of r.report.rows) {
    const d = dim ? row.dimensions[dim] : undefined;
    const key = dim ? (d?.value ?? "(unknown)") : "total";
    const label = !dim ? totalLabel : by === "app" ? (alias.get(key) ?? d?.label ?? key) : (d?.label ?? key);
    const series = bySeries.get(key) ?? { label, days: new Map<string, DaySums>() };
    const date = row.dimensions.DATE?.value ?? "";
    const sums = series.days.get(date) ?? { earnings: 0, requests: 0, matched: 0, impressions: 0 };
    sums.earnings += row.metrics.ESTIMATED_EARNINGS ?? 0;
    sums.requests += row.metrics.AD_REQUESTS ?? 0;
    sums.matched += row.metrics.MATCHED_REQUESTS ?? 0;
    sums.impressions += row.metrics.IMPRESSIONS ?? 0;
    series.days.set(date, sums);
    bySeries.set(key, series);
  }

  const apiDate = (d: ApiDate) => `${d.year}${String(d.month).padStart(2, "0")}${String(d.day).padStart(2, "0")}`;
  const money = (micros: number) => formatMicros(Math.round(micros));
  const highlights: Finding[] = [];
  const all: TrendSeries[] = [...bySeries.entries()].map(([key, s]) => {
    // Every day from the first one with traffic to the end of the range; a day without a row earned nothing.
    const days: TrendDay[] = [];
    for (let d = r.range.startDate; compareDates(d, r.range.endDate) <= 0; d = addDays(d, 1)) {
      const sums = s.days.get(apiDate(d));
      if (!days.length && !sums?.requests && !sums?.earnings) continue;
      const v = sums ?? { earnings: 0, requests: 0, matched: 0, impressions: 0 };
      days.push({
        date: formatDate(d),
        weekday: weekdayOf(d),
        earnings: microsToAmount(v.earnings),
        earnings_micros: v.earnings,
        requests: v.requests,
        impressions: v.impressions,
        match_rate: ratio(v.matched, v.requests),
        show_rate: ratio(v.impressions, v.matched),
        ecpm: perMille(v.earnings, v.impressions),
      });
    }
    const total = days.reduce((a, d) => a + d.earnings_micros, 0);
    const series: TrendSeries = {
      key,
      label: s.label,
      earnings: microsToAmount(total),
      earnings_micros: total,
      active_days: days.length,
      average_per_day: days.length ? microsToAmount(Math.round(total / days.length)) : 0,
      weekdays: WEEKDAYS.map((weekday) => {
        const same = days.filter((d) => d.weekday === weekday);
        return { weekday, days: same.length, average: same.length ? microsToAmount(Math.round(mean(same.map((d) => d.earnings_micros)))) : 0 };
      }),
    };
    if (days.length) series.first_active = days[0]!.date;
    const shift = levelShift(days.map((d) => d.earnings_micros));
    if (shift) {
      const change = (shift.after - shift.before) / shift.before;
      series.shift = {
        date: days[shift.index]!.date,
        before_per_day: microsToAmount(Math.round(shift.before)),
        after_per_day: microsToAmount(Math.round(shift.after)),
        change,
      };
    }
    if (opts.days !== false) series.days = days;
    return series;
  });
  all.sort((a, b) => b.earnings_micros - a.earnings_micros || a.label.localeCompare(b.label));
  const rows = all.slice(0, MAX_SERIES);

  for (const s of rows) {
    if (s.shift) {
      const up = s.shift.change > 0;
      highlights.push({
        kind: up ? "shift-up" : "shift-down",
        key: s.key,
        label: s.label,
        message: `${s.label} ${up ? "rose" : "fell"} from ${s.shift.before_per_day.toFixed(2)} to ${s.shift.after_per_day.toFixed(2)} ${r.currency} per day around ${s.shift.date} (${signedPct(s.shift.change)}).`,
      });
    }
    if (s.first_active && s.first_active !== r.from) {
      highlights.push({ kind: "started", key: s.key, label: s.label, message: `${s.label} has no traffic before ${s.first_active}; averages count from that day.` });
    }
    // A weekday pattern needs every weekday at least twice, and no step that would explain the spread instead.
    const known = s.weekdays.filter((w) => w.days >= 2);
    if (!s.shift && known.length === 7) {
      const high = known.reduce((a, w) => (w.average > a.average ? w : a));
      const low = known.reduce((a, w) => (w.average < a.average ? w : a));
      if (low.average > 0 && high.average >= 1.3 * low.average) {
        highlights.push({
          kind: "weekday",
          key: s.key,
          label: s.label,
          message: `${s.label} earns most on ${high.weekday} (${high.average.toFixed(2)} ${r.currency} on average); the lowest day is ${low.weekday} (${low.average.toFixed(2)}). Compare like weekdays before calling a day a drop.`,
        });
      }
    }
  }

  const overall = all.reduce((a, s) => a + s.earnings_micros, 0);
  const summary = [
    `Estimated earnings ${money(overall)} ${r.currency}, ${r.from} → ${r.to}${by === "total" ? "" : `, ${all.length} ${by} series`}.`,
    ...(highlights.length ? highlights.map((h) => h.message) : ["No clear step in daily earnings and no weekday pattern in this period."]),
    ESTIMATE_LABEL,
  ];
  const notices = [...r.notices];
  if (all.length > rows.length) notices.push(`Showing the ${rows.length} of ${all.length} series with the highest earnings.`);
  return { by, from: r.from, to: r.to, timeZone: r.timeZone, currency: r.currency, estimate: true, rows, highlights, summary, notices };
}
