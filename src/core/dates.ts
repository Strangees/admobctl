import { usageError } from "./errors.js";

export interface ApiDate {
  year: number;
  month: number;
  day: number;
}

export interface DateRange {
  startDate: ApiDate;
  endDate: ApiDate;
}

export interface YearMonth {
  year: number;
  month: number;
}

const MONTH_RE = /^(\d{4})-(\d{2})$/;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function checkMonth(month: number, input: string): void {
  if (month < 1 || month > 12) throw usageError(`Invalid month in "${input}"`);
}

export function parseMonth(input: string): YearMonth {
  const m = MONTH_RE.exec(input);
  if (!m) throw usageError(`Expected YYYY-MM, got "${input}"`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  checkMonth(month, input);
  return { year, month };
}

export function monthEnd({ year, month }: YearMonth): ApiDate {
  return { year, month, day: daysInMonth(year, month) };
}

export function monthRange(input: string): DateRange {
  const ym = parseMonth(input);
  return { startDate: { ...ym, day: 1 }, endDate: monthEnd(ym) };
}

/** Parse YYYY-MM or YYYY-MM-DD. A bare month resolves to its first day (start) or last day (end). */
export function parseDateArg(input: string, edge: "start" | "end"): ApiDate {
  const d = DAY_RE.exec(input);
  if (d) {
    const year = Number(d[1]);
    const month = Number(d[2]);
    const day = Number(d[3]);
    checkMonth(month, input);
    if (day < 1 || day > daysInMonth(year, month)) throw usageError(`Invalid day in "${input}"`);
    return { year, month, day };
  }
  if (!MONTH_RE.test(input)) throw usageError(`Expected YYYY-MM or YYYY-MM-DD, got "${input}"`);
  const ym = parseMonth(input);
  return edge === "start" ? { ...ym, day: 1 } : monthEnd(ym);
}

export function compareDates(a: ApiDate, b: ApiDate): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

export function dateRangeFromArgs(from: string, to: string): DateRange {
  const startDate = parseDateArg(from, "start");
  const endDate = parseDateArg(to, "end");
  if (compareDates(startDate, endDate) > 0) {
    throw usageError(`--from (${from}) is after --to (${to})`);
  }
  return { startDate, endDate };
}

export function formatDate({ year, month, day }: ApiDate): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function formatMonth({ year, month }: YearMonth): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** The calendar date "now" in the given IANA time zone. */
export function todayIn(timeZone: string, now: Date = new Date()): ApiDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

/** True when the whole month lies strictly before `today`. */
export function isMonthComplete(ym: YearMonth, today: ApiDate): boolean {
  return compareDates(monthEnd(ym), today) < 0;
}

function toUtc(d: ApiDate): number {
  return Date.UTC(d.year, d.month - 1, d.day);
}

function fromUtc(ms: number): ApiDate {
  const d = new Date(ms);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

const DAY_MS = 86_400_000;

export function addDays(d: ApiDate, n: number): ApiDate {
  return fromUtc(toUtc(d) + n * DAY_MS);
}

export function daysInRange(r: DateRange): number {
  return Math.round((toUtc(r.endDate) - toUtc(r.startDate)) / DAY_MS) + 1;
}

/** The N complete days ending yesterday (today's data is still partial). */
export function lastNDays(n: number, today: ApiDate): DateRange {
  const endDate = addDays(today, -1);
  return { startDate: addDays(endDate, -(n - 1)), endDate };
}

/** The window of equal length immediately before `r`. */
export function previousPeriod(r: DateRange): DateRange {
  const len = daysInRange(r);
  const endDate = addDays(r.startDate, -1);
  return { startDate: addDays(endDate, -(len - 1)), endDate };
}
