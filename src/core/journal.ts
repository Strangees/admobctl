import { VERSION } from "../version.js";
import type { FinanceConfig } from "./config.js";
import { addDays, compareDates, formatDate, formatMonth, isMonthComplete, parseMonth, todayIn, type ApiDate } from "./dates.js";
import { usageError } from "./errors.js";
import { financeMonth, financeRange, type FinanceMonth } from "./finance.js";
import { currencyDigits } from "./money.js";
import type { AdmobService } from "./service.js";

/**
 * Revenue Journal (spec/SPEC.md): vouchers of balanced debit and credit lines, the shared format
 * every accounting export is built from. Amounts are integers in the currency's minor unit here (cents for NOK,
 * yen for JPY); encoding happens on output.
 */
export const JOURNAL_FORMAT = "revenue-journal/1";

export type AmountEncoding = { encoding: "decimal" } | { encoding: "integer"; scale: number };

export interface VoucherLine {
  line: number;
  role: string;
  side: "debit" | "credit";
  /** Positive, in the minor unit of the voucher's currency. */
  minor: number;
  account?: string;
  account_name?: string;
  dimension?: string;
}

export interface Voucher {
  voucher_id: string;
  kind: "accrual" | "settlement" | "adjustment";
  date: string;
  period: { from: string; to: string };
  currency: string;
  status: "estimate" | "final";
  source: string;
  description: string;
  counterparty?: string;
  account_ref?: string;
  lines: VoucherLine[];
}

export interface RoleAccount {
  account?: string;
  name: string;
}
export type RoleAccounts = Record<"earnings_receivable" | "revenue", RoleAccount>;

/**
 * Accounts per role. Only what the user configured is used; otherwise lines carry the role and a
 * generic English account name, and the user's accounting system maps them.
 */
export function roleAccounts(configured: FinanceConfig | undefined): RoleAccounts {
  const c = configured ?? {};
  const role = (account: string | undefined, name: string | undefined, fallback: string): RoleAccount =>
    account ? { account, name: name ?? fallback } : { name: name ?? fallback };
  return {
    earnings_receivable: role(c.receivableAccount, c.receivableAccountName, "Accounts receivable – AdMob"),
    revenue: role(c.revenueAccount, c.revenueAccountName, "Ad revenue – AdMob"),
  };
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function accountFields(r: RoleAccount): Pick<VoucherLine, "account" | "account_name"> {
  return r.account ? { account: r.account, account_name: r.name } : { account_name: r.name };
}

/**
 * One month's accrual: debit the receivable for the total, credit revenue per app. An app that lost money is a
 * revenue debit, and a month that lost money credits the receivable, so the voucher always balances. A month that
 * has not ended gets an ID of its own (its period), never the month's. Undefined when everything rounds to zero.
 */
export function accrualVoucher(
  m: FinanceMonth,
  ctx: { publisherId: string; counterparty?: string; roles: RoleAccounts },
): Voucher | undefined {
  const toMinor = (amount: number) => Math.round(amount * 10 ** currencyDigits(m.currency));
  const total = toMinor(m.total);
  const apps = m.apps.map((a) => ({ alias: a.alias, minor: toMinor(a.earnings) })).filter((a) => a.minor !== 0);
  if (total === 0 && apps.length === 0) return undefined;
  const lines: Array<Omit<VoucherLine, "line">> = [];
  if (total !== 0) {
    lines.push({ role: "earnings_receivable", side: total > 0 ? "debit" : "credit", minor: Math.abs(total), ...accountFields(ctx.roles.earnings_receivable) });
  }
  for (const a of apps) {
    lines.push({ role: "revenue", side: a.minor > 0 ? "credit" : "debit", minor: Math.abs(a.minor), ...accountFields(ctx.roles.revenue), dimension: a.alias });
  }
  const [year, month] = m.month.split("-");
  const name = `${MONTH_NAMES[Number(month) - 1]} ${year}`;
  return {
    voucher_id: `admob:${ctx.publisherId}:accrual:${m.complete ? m.month : `${m.from}/${m.to}`}`,
    kind: "accrual",
    date: m.bookingDate,
    period: { from: m.from, to: m.to },
    currency: m.currency,
    status: "estimate",
    source: "admob",
    description: m.complete ? `AdMob earnings, ${name}` : `AdMob earnings, ${name} (partial: ${m.from} to ${m.to})`,
    ...(ctx.counterparty ? { counterparty: ctx.counterparty } : {}),
    account_ref: ctx.publisherId,
    lines: lines.map((l, i) => ({ line: i + 1, ...l })),
  };
}

/** `minor` units of a currency with `digits` decimals as a decimal string: 10245 → "102.45", or "10245" for JPY. */
function decimal(minor: number, digits: number): string {
  if (digits === 0) return String(minor);
  const s = String(minor).padStart(digits + 1, "0");
  return `${s.slice(0, -digits)}.${s.slice(-digits)}`;
}

function encoder(amounts: AmountEncoding | undefined): (minor: number, digits: number) => string | number {
  if (!amounts || amounts.encoding === "decimal") return decimal;
  const { scale } = amounts;
  if (!Number.isInteger(scale) || scale < 0 || scale > 6) throw usageError(`--scale must be between 0 and 6, got ${scale}`);
  return (minor, digits) => {
    const divisor = 10 ** Math.max(0, digits - scale);
    if (minor % divisor !== 0) {
      throw usageError(`${decimal(minor, digits)} cannot be written exactly with --scale ${scale}; use --scale ${digits} or more.`);
    }
    const n = (minor / divisor) * 10 ** Math.max(0, scale - digits);
    if (!Number.isSafeInteger(n)) {
      // RJ-AMOUNT: larger integers are not read exactly by every JSON parser.
      const instead = scale > digits ? `use --scale ${digits}, or decimal amounts` : "use decimal amounts";
      throw usageError(`${decimal(minor, digits)} is too large for --scale ${scale} (JSON integers stop at 9007199254740991); ${instead} (without --integer-amounts).`);
    }
    return n;
  };
}

/** The JSON encoding of a Revenue Journal document. */
export function journalDocument(
  vouchers: Voucher[],
  opts: { amounts?: AmountEncoding; producer?: { name: string; version: string } },
): Record<string, unknown> {
  const amount = encoder(opts.amounts);
  return {
    format: JOURNAL_FORMAT,
    ...(opts.producer ? { producer: opts.producer } : {}),
    ...(opts.amounts?.encoding === "integer" ? { amounts: opts.amounts } : {}),
    vouchers: vouchers.map(({ lines, ...v }) => ({
      ...v,
      lines: lines.map(({ side, minor, ...l }) => ({
        line: l.line,
        role: l.role,
        ...(l.account !== undefined ? { account: l.account } : {}),
        ...(l.account_name !== undefined ? { account_name: l.account_name } : {}),
        [side]: amount(minor, currencyDigits(v.currency)),
        ...(l.dimension !== undefined ? { dimension: l.dimension } : {}),
      })),
    })),
  };
}

export const JOURNAL_CSV_COLUMNS = [
  "format", "voucher_id", "kind", "date", "period_from", "period_to", "currency", "status", "source", "description",
  "counterparty", "account_ref", "line", "role", "account", "account_name", "debit", "credit", "vat_code",
  "line_description", "dimension", "foreign_currency", "foreign_amount",
] as const;

const csvField = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** The CSV encoding: one row per line, voucher fields repeated, amounts always decimal. */
export function journalCsv(vouchers: Voucher[]): string {
  const rows = [JOURNAL_CSV_COLUMNS.join(",")];
  for (const v of vouchers) {
    const digits = currencyDigits(v.currency);
    for (const l of v.lines) {
      const row: Record<(typeof JOURNAL_CSV_COLUMNS)[number], string> = {
        format: JOURNAL_FORMAT,
        voucher_id: v.voucher_id,
        kind: v.kind,
        date: v.date,
        period_from: v.period.from,
        period_to: v.period.to,
        currency: v.currency,
        status: v.status,
        source: v.source,
        description: v.description,
        counterparty: v.counterparty ?? "",
        account_ref: v.account_ref ?? "",
        line: String(l.line),
        role: l.role,
        account: l.account ?? "",
        account_name: l.account_name ?? "",
        debit: l.side === "debit" ? decimal(l.minor, digits) : "",
        credit: l.side === "credit" ? decimal(l.minor, digits) : "",
        vat_code: "",
        line_description: "",
        dimension: l.dimension ?? "",
        foreign_currency: "",
        foreign_amount: "",
      };
      rows.push(JOURNAL_CSV_COLUMNS.map((c) => csvField(row[c])).join(","));
    }
  }
  return `${rows.join("\n")}\n`;
}

type RawLine = { line?: unknown; debit?: unknown; credit?: unknown; foreign_amount?: unknown };
type RawVoucher = { voucher_id?: unknown; period?: { from?: unknown; to?: unknown }; lines?: RawLine[] };

/** An amount in either encoding as an exact integer (decimal strings at 4 fraction digits; the scale is per document). */
function units(a: unknown): bigint | undefined {
  if (typeof a === "number") return BigInt(a);
  if (typeof a !== "string") return undefined;
  const [int, frac = ""] = a.split(".");
  return BigInt(`${int}${frac.padEnd(4, "0")}`);
}

/**
 * The rules of SPEC.md §4 that the JSON Schema cannot express: RJ-POSITIVE, RJ-BALANCE, RJ-UNIQUE-ID, RJ-LINES
 * (numbering) and RJ-PERIOD. Expects a document that is already valid against the schema.
 */
export function journalRuleErrors(doc: unknown): string[] {
  const errors: string[] = [];
  const vouchers = ((doc as { vouchers?: RawVoucher[] }).vouchers ?? []) as RawVoucher[];
  const ids = new Set<unknown>();
  vouchers.forEach((v, vi) => {
    const at = `/vouchers/${vi}`;
    if (ids.has(v.voucher_id)) errors.push(`RJ-UNIQUE-ID ${at}: voucher_id ${String(v.voucher_id)} is used twice`);
    ids.add(v.voucher_id);
    if (String(v.period?.from) > String(v.period?.to)) errors.push(`RJ-PERIOD ${at}: period.from is after period.to`);
    let debit = 0n;
    let credit = 0n;
    (v.lines ?? []).forEach((l, li) => {
      if (l.line !== li + 1) errors.push(`RJ-LINES ${at}/lines/${li}: expected line ${li + 1}, got ${String(l.line)}`);
      for (const k of ["debit", "credit", "foreign_amount"] as const) {
        if (units(l[k]) === 0n) errors.push(`RJ-POSITIVE ${at}/lines/${li}: ${k} is zero`);
      }
      debit += units(l.debit) ?? 0n;
      credit += units(l.credit) ?? 0n;
    });
    if (debit !== credit) errors.push(`RJ-BALANCE ${at}: debits and credits differ`);
  });
  return errors;
}

export const EXPORT_FORMATS = ["revenue-journal-json", "revenue-journal-csv"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ExportQuery {
  as: string;
  month?: string;
  from?: string;
  to?: string;
  integerAmounts?: boolean;
  /** Default: the decimals of the currency's minor unit. */
  scale?: number;
  /** Export a month that has not ended as a partial voucher through yesterday, instead of refusing it. */
  allowIncomplete?: boolean;
}

/**
 * The last day to export: undefined when the period has ended. A month that has not ended is refused unless
 * `allowIncomplete`: its voucher would carry the month's ID and month-end date with part of its earnings, and a
 * consumer that skips IDs it has booked would then skip the real one.
 */
async function exportThrough(svc: AdmobService, q: ExportQuery): Promise<ApiDate | undefined> {
  const last = parseMonth(q.month ?? q.to!);
  const { reportingTimeZone } = await svc.account();
  const today = todayIn(reportingTimeZone, svc.now());
  if (isMonthComplete(last, today)) return undefined;
  const label = formatMonth(last);
  const yesterday = addDays(today, -1);
  const latest = formatMonth(addDays({ ...today, day: 1 }, -1));
  if (!q.allowIncomplete) {
    throw usageError(
      `${label} has not ended yet (today is ${formatDate(today)} in ${reportingTimeZone}), so its voucher would carry the month's ID and month-end date with only part of its earnings. Export up to ${latest} (the latest complete month), or add --allow-incomplete for a partial voucher through ${formatDate(yesterday)} with an ID of its own.`,
    );
  }
  if (compareDates({ ...last, day: 1 }, yesterday) > 0) {
    throw usageError(`${label} has no complete day yet (today's data is still arriving), so there is nothing to export. Export up to ${latest}.`);
  }
  return yesterday;
}

/** `finance export`: the accrual vouchers for a month or a range, in one of the export formats. */
export async function exportJournal(svc: AdmobService, q: ExportQuery): Promise<{ content: string; notes: string[] }> {
  if (!(EXPORT_FORMATS as readonly string[]).includes(q.as)) {
    throw usageError(`Unknown export format "${q.as}". Formats: ${EXPORT_FORMATS.join(", ")}`);
  }
  if (q.integerAmounts && q.as !== "revenue-journal-json") {
    throw usageError("--integer-amounts only applies to JSON (revenue-journal-json); CSV amounts are always decimal.");
  }
  if (q.scale !== undefined && !q.integerAmounts) throw usageError("--scale needs --integer-amounts.");
  if (q.month && (q.from || q.to)) throw usageError("Give either --month or --from/--to, not both.");
  if (!q.month && !q.from && !q.to) throw usageError("Give a period: --month YYYY-MM or --from YYYY-MM --to YYYY-MM.");
  if (!q.month && !(q.from && q.to)) throw usageError("A range needs both --from and --to (YYYY-MM).");

  const through = await exportThrough(svc, q);
  const { months, notes, currency } = q.month
    ? await financeMonth(svc, q.month, { through }).then((m) => ({ months: [m], notes: m.notes, currency: m.currency }))
    : await financeRange(svc, q.from!, q.to!, { through }).then((r) => ({ months: r.months, notes: r.notes, currency: r.currency }));
  const acct = await svc.account();
  const ctx = {
    publisherId: acct.publisherId,
    // Only a configured one: which Google entity pays depends on the publisher's country.
    counterparty: svc.profile.financeConfigured.counterparty,
    roles: roleAccounts(svc.profile.financeConfigured),
  };
  const vouchers: Voucher[] = [];
  for (const m of months) {
    const v = accrualVoucher(m, ctx);
    if (!v) notes.push(`${m.month}: no earnings, so no voucher.`);
    else {
      vouchers.push(v);
      if (!m.complete) {
        notes.push(
          `${v.voucher_id} is a partial voucher (${m.from} to ${m.to}), not the month's accrual. Once ${m.month} has ended, reverse it and book admob:${acct.publisherId}:accrual:${m.month} instead.`,
        );
      }
    }
  }
  const content =
    q.as === "revenue-journal-csv"
      ? journalCsv(vouchers)
      : `${JSON.stringify(
          journalDocument(vouchers, {
            producer: { name: "admobctl", version: VERSION },
            amounts: q.integerAmounts ? { encoding: "integer", scale: q.scale ?? currencyDigits(currency) } : undefined,
          }),
          null,
          2,
        )}\n`;
  return { content, notes };
}
