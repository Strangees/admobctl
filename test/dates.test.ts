import { describe, expect, it } from "vitest";
import {
  dateRangeFromArgs,
  formatDate,
  isMonthComplete,
  lastNDays,
  monthEnd,
  monthRange,
  parseMonth,
  previousPeriod,
  todayIn,
} from "../src/core/dates.js";

describe("dateRangeFromArgs", () => {
  it("expands a bare month to its first and last day", () => {
    expect(dateRangeFromArgs("2026-09", "2026-09")).toEqual({
      startDate: { year: 2026, month: 9, day: 1 },
      endDate: { year: 2026, month: 9, day: 30 },
    });
  });

  it("keeps explicit days", () => {
    expect(dateRangeFromArgs("2026-09-05", "2026-09-12")).toEqual({
      startDate: { year: 2026, month: 9, day: 5 },
      endDate: { year: 2026, month: 9, day: 12 },
    });
  });

  it("handles leap-year February", () => {
    expect(dateRangeFromArgs("2028-02", "2028-02").endDate.day).toBe(29);
  });

  it("rejects malformed input with a usable message", () => {
    expect(() => dateRangeFromArgs("09/2026", "2026-09")).toThrow(/YYYY-MM/);
    expect(() => dateRangeFromArgs("2026-13", "2026-13")).toThrow(/month/i);
  });

  it("rejects ranges where from is after to", () => {
    expect(() => dateRangeFromArgs("2026-10", "2026-09")).toThrow(/after/);
  });
});

describe("month helpers", () => {
  it("parses YYYY-MM", () => {
    expect(parseMonth("2026-01")).toEqual({ year: 2026, month: 1 });
    expect(() => parseMonth("2026-1")).toThrow(/YYYY-MM/);
  });

  it("computes month end", () => {
    expect(monthEnd({ year: 2026, month: 9 })).toEqual({ year: 2026, month: 9, day: 30 });
    expect(monthEnd({ year: 2026, month: 12 })).toEqual({ year: 2026, month: 12, day: 31 });
  });

  it("builds a month range", () => {
    expect(monthRange("2026-02")).toEqual({
      startDate: { year: 2026, month: 2, day: 1 },
      endDate: { year: 2026, month: 2, day: 28 },
    });
  });

  it("formats dates as ISO", () => {
    expect(formatDate({ year: 2026, month: 9, day: 3 })).toBe("2026-09-03");
  });
});

describe("todayIn", () => {
  it("uses the account time zone, not UTC", () => {
    // 23:30 UTC on Sep 30 is already Oct 1 in Oslo (UTC+2 in summer).
    const now = new Date("2026-09-30T23:30:00Z");
    expect(todayIn("Europe/Oslo", now)).toEqual({ year: 2026, month: 10, day: 1 });
    expect(todayIn("America/Los_Angeles", now)).toEqual({ year: 2026, month: 9, day: 30 });
  });
});

describe("isMonthComplete", () => {
  const today = { year: 2026, month: 10, day: 2 };
  it("is false for the current month", () => {
    expect(isMonthComplete({ year: 2026, month: 10 }, today)).toBe(false);
  });
  it("is true for past months", () => {
    expect(isMonthComplete({ year: 2026, month: 9 }, today)).toBe(true);
  });
  it("is false for future months", () => {
    expect(isMonthComplete({ year: 2026, month: 11 }, today)).toBe(false);
  });
});

describe("lastNDays", () => {
  it("returns N days ending yesterday", () => {
    expect(lastNDays(30, { year: 2026, month: 10, day: 2 })).toEqual({
      startDate: { year: 2026, month: 9, day: 2 },
      endDate: { year: 2026, month: 10, day: 1 },
    });
  });
});

describe("previousPeriod", () => {
  it("returns the equally long window right before the range", () => {
    expect(
      previousPeriod({
        startDate: { year: 2026, month: 9, day: 2 },
        endDate: { year: 2026, month: 10, day: 1 },
      }),
    ).toEqual({
      startDate: { year: 2026, month: 8, day: 3 },
      endDate: { year: 2026, month: 9, day: 1 },
    });
  });
});
