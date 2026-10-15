import { usageError } from "./errors.mjs";
import { financeMonth, financeRange } from "./finance.mjs";
import { VERSION } from "../version.mjs";

//#region src/core/journal.ts
/**
* Revenue Journal (spec/SPEC.md): vouchers of balanced debit and credit lines, the shared format
* every accounting export is built from. Amounts are integer cents here; encoding happens on output.
*/
const JOURNAL_FORMAT = "revenue-journal/1";
/**
* Accounts per role. Only what the user configured is used; otherwise lines carry the role and a
* generic English account name, and the user's accounting system maps them.
*/
function roleAccounts(configured) {
	const c = configured ?? {};
	const role = (account, name, fallback) => account ? {
		account,
		name: name ?? fallback
	} : { name: name ?? fallback };
	return {
		earnings_receivable: role(c.receivableAccount, c.receivableAccountName, "Accounts receivable – AdMob"),
		revenue: role(c.revenueAccount, c.revenueAccountName, "Ad revenue – AdMob")
	};
}
const MONTH_NAMES = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December"
];
const toCents = (amount) => Math.round(amount * 100);
function accountFields(r) {
	return r.account ? {
		account: r.account,
		account_name: r.name
	} : { account_name: r.name };
}
/** One month's accrual: debit the receivable for the total, credit revenue per app. Undefined when nothing was earned. */
function accrualVoucher(m, ctx) {
	const apps = m.apps.filter((a) => toCents(a.earnings) > 0);
	const total = toCents(m.total);
	if (total <= 0 || apps.length === 0) return void 0;
	const [year, month] = m.month.split("-");
	return {
		voucher_id: `admob:${ctx.publisherId}:accrual:${m.month}`,
		kind: "accrual",
		date: m.bookingDate,
		period: {
			from: m.from,
			to: m.to
		},
		currency: m.currency,
		status: "estimate",
		source: "admob",
		description: `AdMob earnings, ${MONTH_NAMES[Number(month) - 1]} ${year}`,
		counterparty: ctx.counterparty,
		account_ref: ctx.publisherId,
		lines: [{
			line: 1,
			role: "earnings_receivable",
			side: "debit",
			cents: total,
			...accountFields(ctx.roles.earnings_receivable)
		}, ...apps.map((a, i) => ({
			line: i + 2,
			role: "revenue",
			side: "credit",
			cents: toCents(a.earnings),
			...accountFields(ctx.roles.revenue),
			dimension: a.alias
		}))]
	};
}
const decimal = (cents) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
function encoder(amounts) {
	if (!amounts || amounts.encoding === "decimal") return decimal;
	const { scale } = amounts;
	if (!Number.isInteger(scale) || scale < 0 || scale > 6) throw usageError(`--scale must be between 0 and 6, got ${scale}`);
	return (cents) => {
		if (scale >= 2) return cents * 10 ** (scale - 2);
		const divisor = 10 ** (2 - scale);
		if (cents % divisor !== 0) throw usageError(`${decimal(cents)} cannot be written exactly with --scale ${scale}; use --scale 2 or more.`);
		return cents / divisor;
	};
}
/** The JSON encoding of a Revenue Journal document. */
function journalDocument(vouchers, opts) {
	const amount = encoder(opts.amounts);
	return {
		format: JOURNAL_FORMAT,
		...opts.producer ? { producer: opts.producer } : {},
		...opts.amounts?.encoding === "integer" ? { amounts: opts.amounts } : {},
		vouchers: vouchers.map(({ lines, ...v }) => ({
			...v,
			lines: lines.map(({ side, cents, ...l }) => ({
				line: l.line,
				role: l.role,
				...l.account !== void 0 ? { account: l.account } : {},
				...l.account_name !== void 0 ? { account_name: l.account_name } : {},
				[side]: amount(cents),
				...l.dimension !== void 0 ? { dimension: l.dimension } : {}
			}))
		}))
	};
}
const JOURNAL_CSV_COLUMNS = [
	"format",
	"voucher_id",
	"kind",
	"date",
	"period_from",
	"period_to",
	"currency",
	"status",
	"source",
	"description",
	"counterparty",
	"account_ref",
	"line",
	"role",
	"account",
	"account_name",
	"debit",
	"credit",
	"vat_code",
	"line_description",
	"dimension",
	"foreign_currency",
	"foreign_amount"
];
const csvField = (s) => /[",\r\n]/.test(s) ? `"${s.replace(/"/g, "\"\"")}"` : s;
/** The CSV encoding: one row per line, voucher fields repeated, amounts always decimal. */
function journalCsv(vouchers) {
	const rows = [JOURNAL_CSV_COLUMNS.join(",")];
	for (const v of vouchers) for (const l of v.lines) {
		const row = {
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
			debit: l.side === "debit" ? decimal(l.cents) : "",
			credit: l.side === "credit" ? decimal(l.cents) : "",
			vat_code: "",
			line_description: "",
			dimension: l.dimension ?? "",
			foreign_currency: "",
			foreign_amount: ""
		};
		rows.push(JOURNAL_CSV_COLUMNS.map((c) => csvField(row[c])).join(","));
	}
	return `${rows.join("\n")}\n`;
}
const EXPORT_FORMATS = ["revenue-journal-json", "revenue-journal-csv"];
/** `finance export`: the accrual vouchers for a month or a range, in one of the export formats. */
async function exportJournal(svc, q) {
	if (!EXPORT_FORMATS.includes(q.as)) throw usageError(`Unknown export format "${q.as}". Formats: ${EXPORT_FORMATS.join(", ")}`);
	if (q.integerAmounts && q.as !== "revenue-journal-json") throw usageError("--integer-amounts only applies to JSON (revenue-journal-json); CSV amounts are always decimal.");
	if (q.scale !== void 0 && !q.integerAmounts) throw usageError("--scale needs --integer-amounts.");
	if (q.month && (q.from || q.to)) throw usageError("Give either --month or --from/--to, not both.");
	if (!q.month && !q.from && !q.to) throw usageError("Give a period: --month YYYY-MM or --from YYYY-MM --to YYYY-MM.");
	if (!q.month && !(q.from && q.to)) throw usageError("A range needs both --from and --to (YYYY-MM).");
	const { months, notes } = q.month ? await financeMonth(svc, q.month).then((m) => ({
		months: [m],
		notes: m.notes
	})) : await financeRange(svc, q.from, q.to).then((r) => ({
		months: r.months,
		notes: r.notes
	}));
	const ctx = {
		publisherId: (await svc.account()).publisherId,
		counterparty: svc.profile.finance.counterparty,
		roles: roleAccounts(svc.profile.financeConfigured)
	};
	const vouchers = [];
	for (const m of months) {
		const v = accrualVoucher(m, ctx);
		if (v) vouchers.push(v);
		else notes.push(`${m.month}: no earnings, so no voucher.`);
	}
	return {
		content: q.as === "revenue-journal-csv" ? journalCsv(vouchers) : `${JSON.stringify(journalDocument(vouchers, {
			producer: {
				name: "admobctl",
				version: VERSION
			},
			amounts: q.integerAmounts ? {
				encoding: "integer",
				scale: q.scale ?? 2
			} : void 0
		}), null, 2)}\n`,
		notes
	};
}

//#endregion
export { EXPORT_FORMATS, JOURNAL_CSV_COLUMNS, JOURNAL_FORMAT, accrualVoucher, exportJournal, journalCsv, journalDocument, roleAccounts };