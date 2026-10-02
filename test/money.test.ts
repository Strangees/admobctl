import { describe, expect, it } from "vitest";
import { formatMicros, microsToAmount, parseMicros, sumMicros } from "../src/core/money.js";

describe("parseMicros", () => {
  it("parses the API's string micros into an integer", () => {
    expect(parseMicros("102450000")).toBe(102_450_000);
    expect(parseMicros(undefined)).toBe(0);
  });

  it("refuses values that would lose precision", () => {
    expect(() => parseMicros("99999999999999999999")).toThrow(/precision/);
  });
});

describe("formatMicros", () => {
  it("rounds half away from zero to 2 decimals", () => {
    expect(formatMicros(102_445_000)).toBe("102.45");
    expect(formatMicros(102_444_999)).toBe("102.44");
    expect(formatMicros(5_000)).toBe("0.01");
    expect(formatMicros(4_999)).toBe("0.00");
    expect(formatMicros(-5_000)).toBe("-0.01");
  });

  it("supports other precisions", () => {
    expect(formatMicros(1_234_567, 4)).toBe("1.2346");
    expect(formatMicros(1_000_000, 0)).toBe("1");
  });
});

describe("microsToAmount", () => {
  it("returns a rounded number for JSON output", () => {
    expect(microsToAmount(361_115_000)).toBe(361.12);
  });
});

describe("sumMicros", () => {
  it("sums integers exactly", () => {
    expect(sumMicros([100_000_001, 200_000_002, 3])).toBe(300_000_006);
  });
});
