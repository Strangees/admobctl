import type { AppRef } from "./aliases.js";
import type { FinanceConfig } from "./config.js";
import { addDays, compareDates, formatDate, formatMonth, isMonthComplete, monthEnd, monthRange, parseMonth, todayIn, type YearMonth } from "./dates.js";
import { usageError } from "./errors.js";
import { microsToAmount, sumMicros } from "./money.js";
import type { AdmobService } from "./service.js";

export const ESTIMATE_LABEL = "Estimated earnings, reconcile against AdMob Payments (finalized).";

export interface FinanceApp {
  alias: string;
  name: string;
  appId: string;
  platform?: string;
  /** Rounded so that the apps sum exactly to `total`. */
  earnings: number;
  earningsMicros: number;
}

export interface FinanceMonth {
  month: string;
  from: string;
  to: string;
  /** Last day of the month: the booking date. */
  bookingDate: string;
  currency: string;
  timeZone: string;
  complete: boolean;
  estimate: true;
  total: number;
  totalMicros: number;
  apps: FinanceApp[];
  notes: string[];
}

export interface FinanceRange {
  from: string;
  to: string;
  currency: string;
  timeZone: string;
  estimate: true;
  total: number;
  totalMicros: number;
  months: FinanceMonth[];
  notes: string[];
}

/**
 * Round micros to cents with the largest-remainder method: the parts always
 * add up to the half-up rounded total, so journal rows balance.
 */
export function allocateRounded(micros: number[]): { total: number; parts: number[] } {
  const CENT = 10_000;
  const totalMicros = sumMicros(micros);
  const total = Math.sign(totalMicros) * Math.floor((Math.abs(totalMicros) + CENT / 2) / CENT);
  const floors = micros.map((m) => Math.floor(m / CENT));
  let remaining = total - floors.reduce((a, b) => a + b, 0);
  const order = micros
    .map((m, i) => ({ i, rem: m - floors[i]! * CENT }))
    .sort((a, b) => b.rem - a.rem || a.i - b.i);
  const parts = [...floors];
  for (const { i } of order) {
    if (remaining <= 0) break;
    parts[i]! += 1;
    remaining -= 1;
  }
  return { total, parts };
}

const cents = (c: number) => c / 100;

function appsFromMicros(byApp: Map<string, number>, index: AppRef[]): { apps: FinanceApp[]; total: number } {
  const byId = new Map(index.map((a) => [a.appId, a]));
  const entries = [...byApp.entries()].sort((a, b) => b[1] - a[1]);
  const { total, parts } = allocateRounded(entries.map(([, m]) => m));
  const apps = entries.map(([appId, micros], i) => {
    const ref = byId.get(appId);
    const app: FinanceApp = {
      alias: ref?.alias ?? appId,
      name: ref?.name ?? appId,
      appId,
      earnings: cents(parts[i]!),
      earningsMicros: micros,
    };
    if (ref?.platform) app.platform = ref.platform;
    return app;
  });
  return { apps, total: cents(total) };
}

function monthNotes(complete: boolean, month: string): string[] {
  const notes = [ESTIMATE_LABEL];
  if (!complete) notes.push(`${month} is incomplete (the month has not ended yet); the figures will change.`);
  return notes;
}

function buildMonth(ym: YearMonth, byApp: Map<string, number>, index: AppRef[], ctx: { currency: string; timeZone: string; today: ReturnType<typeof todayIn> }): FinanceMonth {
  const month = formatMonth(ym);
  const complete = isMonthComplete(ym, ctx.today);
  const { apps, total } = appsFromMicros(byApp, index);
  return {
    month,
    from: formatDate({ ...ym, day: 1 }),
    to: formatDate(monthEnd(ym)),
    bookingDate: formatDate(monthEnd(ym)),
    currency: ctx.currency,
    timeZone: ctx.timeZone,
    complete,
    estimate: true,
    total,
    totalMicros: sumMicros(byApp.values()),
    apps,
    notes: monthNotes(complete, month),
  };
}

export async function financeMonth(svc: AdmobService, month: string): Promise<FinanceMonth> {
  const ym = parseMonth(month);
  const acct = await svc.account();
  const [{ report }, index] = await Promise.all([
    svc.rawReport("network", { dateRange: monthRange(month), by: ["app"], metrics: ["earnings"] }),
    svc.apps(),
  ]);
  const byApp = new Map<string, number>();
  for (const row of report.rows) {
    const id = row.dimensions.APP?.value ?? "unknown";
    byApp.set(id, (byApp.get(id) ?? 0) + (row.metrics.ESTIMATED_EARNINGS ?? 0));
  }
  const timeZone = report.timeZone ?? acct.reportingTimeZone;
  return buildMonth(ym, byApp, index, {
    currency: report.currency ?? acct.currencyCode,
    timeZone,
    today: todayIn(timeZone, svc.now()),
  });
}

export async function financeRange(svc: AdmobService, from: string, to: string): Promise<FinanceRange> {
  const start = parseMonth(from);
  const end = parseMonth(to);
  if (start.year * 12 + start.month > end.year * 12 + end.month) throw usageError(`--from (${from}) is after --to (${to})`);
  const acct = await svc.account();
  const dateRange = { startDate: { ...start, day: 1 }, endDate: monthEnd(end) };
  const [{ report }, index] = await Promise.all([
    svc.rawReport("network", { dateRange, by: ["month", "app"], metrics: ["earnings"] }),
    svc.apps(),
  ]);
  const byMonth = new Map<string, Map<string, number>>();
  for (let y = start.year, m = start.month; y * 12 + m <= end.year * 12 + end.month; m === 12 ? (y++, (m = 1)) : m++) {
    byMonth.set(`${y}${String(m).padStart(2, "0")}`, new Map());
  }
  for (const row of report.rows) {
    const key = row.dimensions.MONTH?.value ?? "";
    const bucket = byMonth.get(key);
    if (!bucket) continue;
    const id = row.dimensions.APP?.value ?? "unknown";
    bucket.set(id, (bucket.get(id) ?? 0) + (row.metrics.ESTIMATED_EARNINGS ?? 0));
  }
  const timeZone = report.timeZone ?? acct.reportingTimeZone;
  const ctx = { currency: report.currency ?? acct.currencyCode, timeZone, today: todayIn(timeZone, svc.now()) };
  const months = [...byMonth.entries()].map(([key, apps]) =>
    buildMonth({ year: Number(key.slice(0, 4)), month: Number(key.slice(4, 6)) }, apps, index, ctx),
  );
  const totalMicros = sumMicros(months.map((m) => m.totalMicros));
  // Each month is booked rounded to cents, so the range total is the sum of those, not the exact micros
  // rounded once; that way it matches the journal and the books.
  const monthCents = months.reduce((a, m) => a + Math.round(m.total * 100), 0);
  const total = cents(monthCents);
  const notes = [ESTIMATE_LABEL];
  const incomplete = months.filter((m) => !m.complete).map((m) => m.month);
  if (incomplete.length) notes.push(`Incomplete month(s): ${incomplete.join(", ")}; the figures will change.`);
  const exact = allocateRounded([totalMicros]).total;
  if (exact !== monthCents) {
    notes.push(
      `The total ${total.toFixed(2)} is the sum of the month totals, as booked; the exact earnings round to ${cents(exact).toFixed(2)}.`,
    );
  }
  return {
    from: formatDate(dateRange.startDate),
    to: formatDate(dateRange.endDate),
    currency: ctx.currency,
    timeZone,
    estimate: true,
    total,
    totalMicros,
    months,
    notes,
  };
}

export interface ForecastApp {
  alias: string;
  name: string;
  appId: string;
  platform?: string;
  /** Rounded so that the apps sum exactly to the totals. */
  month_to_date: number;
  month_to_date_micros: number;
  projected: number;
  projected_micros: number;
}

export interface FinanceForecast {
  month: string;
  from: string;
  to: string;
  currency: string;
  timeZone: string;
  complete: boolean;
  estimate: true;
  /** False once the month has ended: `projected` is then the actual estimate. */
  projection: boolean;
  /** Complete days counted (today is left out: its data is still arriving). */
  days_elapsed: number;
  days_in_month: number;
  days_remaining: number;
  month_to_date: number;
  month_to_date_micros: number;
  daily_average: number;
  projected: number;
  projected_micros: number;
  apps: ForecastApp[];
  notes: string[];
}

/**
 * Month-end pacing: earnings over the month's complete days, scaled to the whole month per app.
 * `month` defaults to the current month in the account's time zone.
 */
export async function financeForecast(svc: AdmobService, month?: string): Promise<FinanceForecast> {
  const acct = await svc.account();
  const today = todayIn(acct.reportingTimeZone, svc.now());
  const ym = month ? parseMonth(month) : { year: today.year, month: today.month };
  const label = formatMonth(ym);
  const start = { ...ym, day: 1 };
  const end = monthEnd(ym);
  if (compareDates(start, today) > 0) throw usageError(`${label} has not started yet, so there is nothing to project from.`);
  const complete = isMonthComplete(ym, today);
  const lastDay = complete ? end : addDays(today, -1);
  if (compareDates(lastDay, start) < 0) {
    throw usageError(`${label} has no complete day yet (today's data is still arriving). Try again tomorrow, or: admobctl finance month <last month>`);
  }
  const [{ report }, index] = await Promise.all([
    svc.rawReport("network", { dateRange: { startDate: start, endDate: lastDay }, by: ["app"], metrics: ["earnings"] }),
    svc.apps(),
  ]);
  const elapsed = lastDay.day;
  const scale = (micros: number) => Math.round((micros * end.day) / elapsed);
  const toDate = new Map<string, number>();
  for (const row of report.rows) {
    const id = row.dimensions.APP?.value ?? "unknown";
    toDate.set(id, (toDate.get(id) ?? 0) + (row.metrics.ESTIMATED_EARNINGS ?? 0));
  }
  const actual = appsFromMicros(toDate, index);
  const projected = appsFromMicros(new Map([...toDate].map(([id, m]) => [id, scale(m)])), index);
  const projectedById = new Map(projected.apps.map((a) => [a.appId, a]));
  const toDateMicros = sumMicros(toDate.values());
  const notes = [ESTIMATE_LABEL];
  if (!complete) {
    notes.unshift(
      `Projection: the daily average of ${elapsed} of ${end.day} days (${formatDate(start)} → ${formatDate(lastDay)}) carried to month-end. It assumes the rest of the month earns like the days so far; do not book it.`,
    );
  } else notes.unshift(`${label} has ended: this is the month's estimate, not a projection.`);
  return {
    month: label,
    from: formatDate(start),
    to: formatDate(end),
    currency: report.currency ?? acct.currencyCode,
    timeZone: report.timeZone ?? acct.reportingTimeZone,
    complete,
    estimate: true,
    projection: !complete,
    days_elapsed: elapsed,
    days_in_month: end.day,
    days_remaining: end.day - elapsed,
    month_to_date: actual.total,
    month_to_date_micros: toDateMicros,
    daily_average: microsToAmount(Math.round(toDateMicros / elapsed)),
    projected: projected.total,
    projected_micros: sumMicros(projected.apps.map((a) => a.earningsMicros)),
    apps: actual.apps.map((a) => {
      const p = projectedById.get(a.appId)!;
      const app: ForecastApp = {
        alias: a.alias,
        name: a.name,
        appId: a.appId,
        month_to_date: a.earnings,
        month_to_date_micros: a.earningsMicros,
        projected: p.earnings,
        projected_micros: p.earningsMicros,
      };
      if (a.platform) app.platform = a.platform;
      return app;
    }),
    notes,
  };
}

export const JOURNAL_COLUMNS = [
  "Bilag", "Dato", "Kilde", "Beskrivelse", "Konto", "Kontonavn", "Debet", "Kredit",
  "MVA-behandling", "Motpart", "Status", "Merknad",
] as const;

export type JournalRow = Record<(typeof JOURNAL_COLUMNS)[number], string>;

const MONTH_NAMES_NB = ["januar", "februar", "mars", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "desember"];

/**
 * Bilagsjournal rows for one month: debit the receivable for the total, credit
 * revenue per app. Amounts are allocated so debit == sum of credits.
 */
export function journalRows(m: FinanceMonth, finance: Required<FinanceConfig>): JournalRow[] {
  const amount = (n: number) => n.toFixed(2).replace(".", finance.decimalSeparator);
  const [y, mo] = m.month.split("-");
  const period = `${MONTH_NAMES_NB[Number(mo) - 1]} ${y}`;
  const status = m.complete ? "Estimert" : "Estimert (ufullstendig måned)";
  const note = `Estimat fra AdMob API, avstem mot AdMob Payments (finalized). ${m.currency}.`;
  const base = { Bilag: "", Dato: m.bookingDate, Kilde: "AdMob (admobctl)", "MVA-behandling": finance.vatTreatment, Motpart: finance.counterparty, Status: status, Merknad: note };
  const rows: JournalRow[] = [
    {
      ...base,
      Beskrivelse: `AdMob opptjent ${period}`,
      Konto: finance.receivableAccount,
      Kontonavn: finance.receivableAccountName,
      Debet: amount(m.total),
      Kredit: "",
    },
    ...m.apps.map((a) => ({
      ...base,
      Beskrivelse: `AdMob ${period}: ${a.alias}`,
      Konto: finance.revenueAccount,
      Kontonavn: finance.revenueAccountName,
      Debet: "",
      Kredit: amount(a.earnings),
    })),
  ];
  // Fixed column order for paste-ready output.
  return rows.map((r) => Object.fromEntries(JOURNAL_COLUMNS.map((c) => [c, r[c]])) as JournalRow);
}
