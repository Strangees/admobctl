import type { AppRef } from "./aliases.js";
import type { FinanceConfig } from "./config.js";
import { formatDate, formatMonth, isMonthComplete, monthEnd, monthRange, parseMonth, todayIn, type YearMonth } from "./dates.js";
import { usageError } from "./errors.js";
import { sumMicros } from "./money.js";
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
