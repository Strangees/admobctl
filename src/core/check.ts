import { CHECK_BASELINE } from "./config.js";
import { addDays, formatDate, lastNDays, timeIn, todayIn, type ApiDate, type DateRange } from "./dates.js";
import { usageError } from "./errors.js";
import { ESTIMATE_LABEL } from "./finance.js";
import { pct, ratio } from "./insights.js";
import { formatMicros, microsToAmount } from "./money.js";
import type { Report } from "./report.js";
import type { AdmobService } from "./service.js";

/**
 * A health check for cron and agents: did earnings, fill or show rate drop against a baseline? By default the
 * baseline is the window's weekdays in the four weeks before, so an app with a weekly pattern does not breach on
 * every weekly low.
 */

export interface CheckOptions {
  /** Complete days to judge, ending yesterday (default 1). */
  window?: number;
  /** Compare with this many days just before the window (the default, 7, for windows over 7 days). */
  baseline?: number;
  /** Compare with the window's weekdays in this many weeks before it (the default, 4, for windows up to 7 days). */
  baselineWeeks?: number;
  /** A drop of this fraction or more is a breach (default 0.3). */
  drop?: number;
  /** Baseline requests an app needs before it is judged (default 1000). */
  minRequests?: number;
  app?: string;
}

export const CHECK_DEFAULTS = { window: 1, baselineWeeks: 4, baseline: 7, drop: 0.3, minRequests: 1000 };

/** Every weekday comes round again 7 days later, so a window of up to 7 days has its weekdays in each week before it. */
const MAX_WEEKDAY_WINDOW = 7;

export type CheckMetric = "earnings" | "requests" | "match_rate" | "show_rate";

export interface CheckRow {
  app: string;
  app_id: string;
  /** ok, breach, or thin: too little baseline traffic to judge. */
  status: "ok" | "breach" | "thin";
  earnings_per_day: number;
  earnings_per_day_micros: number;
  baseline_earnings_per_day: number;
  baseline_earnings_per_day_micros: number;
  /** Relative change against the baseline (−0.5 = half); absent when the baseline is zero. */
  earnings_change?: number;
  requests: number;
  baseline_requests: number;
  match_rate: number;
  baseline_match_rate: number;
  show_rate: number;
  baseline_show_rate: number;
}

export interface CheckFinding {
  app: string;
  metric: CheckMetric;
  /** Relative change against the baseline. */
  change: number;
  message: string;
}

export interface CheckResult {
  window: { from: string; to: string; days: number };
  /** With `weeks`, only the window's weekdays between from and to count, and `days` counts those. */
  baseline: { from: string; to: string; days: number; weeks?: number };
  thresholds: { drop: number; min_requests: number };
  currency: string;
  timeZone: string;
  estimate: true;
  breaches: number;
  rows: CheckRow[];
  /** All apps together; left out when the check is limited to one app. */
  total?: CheckRow;
  findings: CheckFinding[];
  summary: string[];
  notices: string[];
}

interface Sums {
  earnings: number;
  requests: number;
  matched: number;
  impressions: number;
}

const ZERO: Sums = { earnings: 0, requests: 0, matched: 0, impressions: 0 };

/** Sums per app; with `days` (YYYYMMDD), only rows of those dates. */
function sumByApp(report: Report, days?: Set<string>): Map<string, Sums> {
  const out = new Map<string, Sums>();
  for (const row of report.rows) {
    if (days && !days.has(row.dimensions.DATE?.value ?? "")) continue;
    const id = row.dimensions.APP?.value ?? "unknown";
    const s = out.get(id) ?? { ...ZERO };
    s.earnings += row.metrics.ESTIMATED_EARNINGS ?? 0;
    s.requests += row.metrics.AD_REQUESTS ?? 0;
    s.matched += row.metrics.MATCHED_REQUESTS ?? 0;
    s.impressions += row.metrics.IMPRESSIONS ?? 0;
    out.set(id, s);
  }
  return out;
}

const add = (a: Sums, b: Sums): Sums => ({
  earnings: a.earnings + b.earnings,
  requests: a.requests + b.requests,
  matched: a.matched + b.matched,
  impressions: a.impressions + b.impressions,
});

function wholeNumber(value: number | undefined, configured: string | undefined, fallback: number, name: string, max: number): number {
  const n = value ?? (configured === undefined ? fallback : Number(configured));
  if (!Number.isInteger(n) || n < 1 || n > max) throw usageError(`${name} must be a whole number between 1 and ${max}, got "${value ?? configured}"`);
  return n;
}

/** The baseline asked for, by options and then config: days just before the window, or weeks of the same weekdays. */
function askedBaseline(opts: CheckOptions, configured: string | undefined): { days?: number; weeks?: number } | undefined {
  if (opts.baseline !== undefined && opts.baselineWeeks !== undefined) throw usageError("Give the baseline in days or in weeks, not both.");
  if (opts.baseline !== undefined || opts.baselineWeeks !== undefined) return { days: opts.baseline, weeks: opts.baselineWeeks };
  if (configured === undefined) return undefined;
  const m = CHECK_BASELINE.exec(configured);
  if (!m) throw usageError(`check.baseline must be days like 7d or weeks like 4w, got "${configured}"`);
  return m[2] === "w" ? { weeks: Number(m[1]) } : { days: Number(m[1]) };
}

const apiDate = (d: ApiDate) => formatDate(d).replace(/-/g, "");

export async function check(svc: AdmobService, opts: CheckOptions = {}): Promise<CheckResult> {
  const cfg = svc.profile.check ?? {};
  const windowDays = wholeNumber(opts.window, cfg.window, CHECK_DEFAULTS.window, "The window (--window, check.window) in days", 90);
  const asked = askedBaseline(opts, cfg.baseline);
  let weeks: number | undefined;
  let baselineDays: number;
  if (asked ? asked.weeks !== undefined : windowDays <= MAX_WEEKDAY_WINDOW) {
    weeks = wholeNumber(asked?.weeks, undefined, CHECK_DEFAULTS.baselineWeeks, "The baseline (--baseline, check.baseline) in weeks", 52);
    if (windowDays > MAX_WEEKDAY_WINDOW) {
      throw usageError(`A baseline in weeks compares the same weekdays, so it needs a window of 7 days or fewer, not ${windowDays}. Give it in days, e.g. --baseline 28d.`);
    }
    baselineDays = weeks * windowDays;
  } else {
    baselineDays = wholeNumber(asked?.days, undefined, CHECK_DEFAULTS.baseline, "The baseline (--baseline, check.baseline) in days", 366);
  }
  const dropPercent = opts.drop !== undefined ? opts.drop * 100 : cfg.drop === undefined ? CHECK_DEFAULTS.drop * 100 : Number(cfg.drop);
  if (!(dropPercent >= 1 && dropPercent <= 99)) throw usageError("The drop threshold (--drop, check.drop) must be between 1 and 99 (percent).");
  const drop = dropPercent / 100;
  const minRequests = wholeNumber(opts.minRequests, cfg.minRequests, CHECK_DEFAULTS.minRequests, "The minimum requests (--min-requests, check.minRequests)", 1e9);

  const acct = await svc.account();
  const asOf = svc.now();
  const window = lastNDays(windowDays, todayIn(acct.reportingTimeZone, asOf));
  // In weeks: the window moved back 1 to N weeks. Fetched as one range by date, keeping the days of those copies.
  const baseline: DateRange = weeks
    ? { startDate: addDays(window.startDate, -7 * weeks), endDate: addDays(window.endDate, -7) }
    : { startDate: addDays(window.startDate, -baselineDays), endDate: addDays(window.startDate, -1) };
  const sameWeekdays = weeks
    ? new Set(Array.from({ length: baselineDays }, (_, i) => apiDate(addDays(baseline.startDate, Math.floor(i / windowDays) * 7 + (i % windowDays)))))
    : undefined;
  const [{ current, previous }, apps] = await Promise.all([
    svc.rawReportWithPrevious(
      "network",
      {
        dateRange: window,
        by: ["app"],
        metrics: ["earnings", "requests", "matched-requests", "impressions"],
        filters: opts.app ? { app: [opts.app] } : undefined,
      },
      weeks ? { dateRange: baseline, by: ["app", "date"] } : { dateRange: baseline },
    ),
    svc.apps(),
  ]);
  const currency = current.report.currency ?? acct.currencyCode;
  const now = sumByApp(current.report);
  const before = sumByApp(previous.report, sameWeekdays);
  const alias = new Map(apps.map((a) => [a.appId, a.alias]));
  const perDay = (micros: number, days: number) => Math.round(micros / days);
  const money = (micros: number) => `${formatMicros(micros)} ${currency}`;

  const findings: CheckFinding[] = [];
  const judge = (app: string, appId: string, w: Sums, b: Sums): CheckRow => {
    const earnings = perDay(w.earnings, windowDays);
    const baseEarnings = perDay(b.earnings, baselineDays);
    const row: CheckRow = {
      app,
      app_id: appId,
      status: "ok",
      earnings_per_day: microsToAmount(earnings),
      earnings_per_day_micros: earnings,
      baseline_earnings_per_day: microsToAmount(baseEarnings),
      baseline_earnings_per_day_micros: baseEarnings,
      requests: w.requests,
      baseline_requests: b.requests,
      match_rate: ratio(w.matched, w.requests),
      baseline_match_rate: ratio(b.matched, b.requests),
      show_rate: ratio(w.impressions, w.matched),
      baseline_show_rate: ratio(b.impressions, b.matched),
    };
    if (b.earnings > 0) row.earnings_change = (w.earnings / windowDays - b.earnings / baselineDays) / (b.earnings / baselineDays);
    if (b.requests < minRequests) {
      row.status = "thin";
      return row;
    }
    const breach = (metric: CheckMetric, change: number, message: string) => {
      row.status = "breach";
      findings.push({ app, metric, change, message });
    };
    if (w.requests === 0 && b.earnings === 0) {
      // Nothing earned in the baseline either, so the earnings check cannot see an app that went quiet.
      breach("requests", -1, `${app} sent no ad requests in the window, after ${b.requests} in the baseline. Check that the app still loads ads (release, SDK, app-ads.txt, account status).`);
    }
    if (row.earnings_change !== undefined && row.earnings_change <= -drop) {
      breach(
        "earnings",
        row.earnings_change,
        w.requests === 0
          ? `${app} sent no ad requests in the window; its baseline is ${money(baseEarnings)} per day. Check that the app still loads ads (release, SDK, app-ads.txt, account status).`
          : `${app} earned ${money(earnings)} per day, ${pct(-row.earnings_change)} below its ${money(baseEarnings)} baseline.`,
      );
    }
    // Rates are judged only on enough window traffic: a tenth of the baseline minimum.
    const rate = (metric: CheckMetric, name: string, value: number, base: number, denominator: number) => {
      if (denominator < minRequests / 10 || base <= 0) return;
      const change = (value - base) / base;
      if (change <= -drop) breach(metric, change, `${app}: ${name} fell to ${pct(value)} from ${pct(base)}.`);
    };
    rate("match_rate", "match rate", row.match_rate, row.baseline_match_rate, w.requests);
    rate("show_rate", "show rate", row.show_rate, row.baseline_show_rate, w.matched);
    return row;
  };

  const ids = [...new Set([...before.keys(), ...now.keys()])].sort(
    (a, b) => (before.get(b)?.earnings ?? 0) - (before.get(a)?.earnings ?? 0) || (now.get(b)?.earnings ?? 0) - (now.get(a)?.earnings ?? 0),
  );
  const rows = ids.map((id) => judge(alias.get(id) ?? id, id, now.get(id) ?? ZERO, before.get(id) ?? ZERO));
  const result: CheckResult = {
    window: { from: formatDate(window.startDate), to: formatDate(window.endDate), days: windowDays },
    baseline: { from: formatDate(baseline.startDate), to: formatDate(baseline.endDate), days: baselineDays, ...(weeks ? { weeks } : {}) },
    thresholds: { drop, min_requests: minRequests },
    currency,
    timeZone: current.report.timeZone ?? acct.reportingTimeZone,
    estimate: true,
    breaches: 0,
    rows,
    findings,
    summary: [],
    notices: [...current.report.warnings.map((w) => `API warning: ${w}`), ...current.notices],
  };
  if (!opts.app) result.total = judge("(all apps)", "", [...now.values()].reduce(add, ZERO), [...before.values()].reduce(add, ZERO));
  result.breaches = findings.length;

  const thin = rows.filter((r) => r.status === "thin").length;
  if (thin) {
    result.notices.push(`${thin} ${thin === 1 ? "app" : "apps"} had fewer than ${minRequests} requests in the baseline and ${thin === 1 ? "was" : "were"} not judged.`);
  }
  // Network data lands a few hours late, so early in the morning yesterday can look like a drop.
  const clock = timeIn(acct.reportingTimeZone, asOf);
  if (Number(clock.slice(0, 2)) < 4) {
    result.notices.unshift(
      `It is ${clock} in ${acct.reportingTimeZone}: AdMob data arrives a few hours late, so yesterday's figures may still be incomplete and look like a drop. Run the check after about 04:00 there.`,
    );
  }
  const { from, to } = result.baseline;
  const range = from === to ? from : `${from} → ${to}`;
  const day = new Date(`${result.window.from}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  const against = !weeks
    ? range
    : windowDays === 1
      ? `the ${weeks === 1 ? day : `${weeks} ${day}s`} before (${range})`
      : `the same weekdays in the ${weeks === 1 ? "week" : `${weeks} weeks`} before (${range})`;
  const span = `${result.window.from}${windowDays > 1 ? ` → ${result.window.to}` : ""} against ${against}`;
  result.summary = findings.length
    ? [`${findings.length} ${findings.length === 1 ? "drop" : "drops"} of ${pct(drop)} or more, ${span}.`, ...findings.map((f) => f.message), ESTIMATE_LABEL]
    : [`No drop of ${pct(drop)} or more in earnings, match rate or show rate, ${span}.`, ESTIMATE_LABEL];
  return result;
}
