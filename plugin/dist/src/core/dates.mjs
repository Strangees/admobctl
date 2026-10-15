import { usageError } from "./errors.mjs";

//#region src/core/dates.ts
const MONTH_RE = /^(\d{4})-(\d{2})$/;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
function daysInMonth(year, month) {
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
function checkMonth(month, input) {
	if (month < 1 || month > 12) throw usageError(`Invalid month in "${input}"`);
}
function parseMonth(input) {
	const m = MONTH_RE.exec(input);
	if (!m) throw usageError(`Expected YYYY-MM, got "${input}"`);
	const year = Number(m[1]);
	const month = Number(m[2]);
	checkMonth(month, input);
	return {
		year,
		month
	};
}
function monthEnd({ year, month }) {
	return {
		year,
		month,
		day: daysInMonth(year, month)
	};
}
function monthRange(input) {
	const ym = parseMonth(input);
	return {
		startDate: {
			...ym,
			day: 1
		},
		endDate: monthEnd(ym)
	};
}
/** Parse YYYY-MM or YYYY-MM-DD. A bare month resolves to its first day (start) or last day (end). */
function parseDateArg(input, edge) {
	const d = DAY_RE.exec(input);
	if (d) {
		const year = Number(d[1]);
		const month = Number(d[2]);
		const day = Number(d[3]);
		checkMonth(month, input);
		if (day < 1 || day > daysInMonth(year, month)) throw usageError(`Invalid day in "${input}"`);
		return {
			year,
			month,
			day
		};
	}
	if (!MONTH_RE.test(input)) throw usageError(`Expected YYYY-MM or YYYY-MM-DD, got "${input}"`);
	const ym = parseMonth(input);
	return edge === "start" ? {
		...ym,
		day: 1
	} : monthEnd(ym);
}
function compareDates(a, b) {
	return a.year - b.year || a.month - b.month || a.day - b.day;
}
function dateRangeFromArgs(from, to) {
	const startDate = parseDateArg(from, "start");
	const endDate = parseDateArg(to, "end");
	if (compareDates(startDate, endDate) > 0) throw usageError(`--from (${from}) is after --to (${to})`);
	return {
		startDate,
		endDate
	};
}
function formatDate({ year, month, day }) {
	return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
function formatMonth({ year, month }) {
	return `${year}-${String(month).padStart(2, "0")}`;
}
/** The calendar date "now" in the given IANA time zone. */
function todayIn(timeZone, now = /* @__PURE__ */ new Date()) {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit"
	}).formatToParts(now);
	const get = (type) => Number(parts.find((p) => p.type === type)?.value);
	return {
		year: get("year"),
		month: get("month"),
		day: get("day")
	};
}
/** True when the whole month lies strictly before `today`. */
function isMonthComplete(ym, today) {
	return compareDates(monthEnd(ym), today) < 0;
}
function toUtc(d) {
	return Date.UTC(d.year, d.month - 1, d.day);
}
function fromUtc(ms) {
	const d = new Date(ms);
	return {
		year: d.getUTCFullYear(),
		month: d.getUTCMonth() + 1,
		day: d.getUTCDate()
	};
}
const DAY_MS = 864e5;
function addDays(d, n) {
	return fromUtc(toUtc(d) + n * DAY_MS);
}
function daysInRange(r) {
	return Math.round((toUtc(r.endDate) - toUtc(r.startDate)) / DAY_MS) + 1;
}
/** The N complete days ending yesterday (today's data is still partial). */
function lastNDays(n, today) {
	const endDate = addDays(today, -1);
	return {
		startDate: addDays(endDate, -(n - 1)),
		endDate
	};
}
/** The window of equal length immediately before `r`. */
function previousPeriod(r) {
	const len = daysInRange(r);
	const endDate = addDays(r.startDate, -1);
	return {
		startDate: addDays(endDate, -(len - 1)),
		endDate
	};
}
/** Split a range into consecutive chunks of at most `maxDays` days. */
function splitRange(r, maxDays) {
	const out = [];
	for (let start = r.startDate; compareDates(start, r.endDate) <= 0; start = addDays(start, maxDays)) {
		const end = addDays(start, maxDays - 1);
		out.push({
			startDate: start,
			endDate: compareDates(end, r.endDate) < 0 ? end : r.endDate
		});
	}
	return out;
}

//#endregion
export { addDays, compareDates, dateRangeFromArgs, daysInRange, formatDate, formatMonth, isMonthComplete, lastNDays, monthEnd, monthRange, parseDateArg, parseMonth, previousPeriod, splitRange, todayIn };