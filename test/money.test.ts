import { describe, expect, it } from "vitest";
import { formatMicros, microsToAmount, parseMicros, sumMicros } from "../src/core/money.js";
import { AdmobctlError } from "../src/core/errors.js";

function catching(fn: () => unknown): AdmobctlError {
  try {
    fn();
  } catch (e) {
    return e as AdmobctlError;
  }
  throw new Error("expected a throw");
}

describe("parseMicros", () => {
  it("parses the API's string micros into an integer", () => {
    expect(parseMicros("102450000")).toBe(102_450_000);
    expect(parseMicros(undefined)).toBe(0);
  });

  it("refuses values that would lose precision", () => {
    expect(() => parseMicros("99999999999999999999")).toThrow(/precision/);
  });

  it("refuses them with an AdmobctlError that says how to get a smaller amount", () => {
    const err = catching(() => parseMicros("99999999999999999999"));
    expect(err).toBeInstanceOf(AdmobctlError);
    expect(err.fix).toMatch(/date range.*--currency USD/);
  });

  it("refuses a value that is not a number with an API error, not a bare Error", () => {
    expect(catching(() => parseMicros("abc"))).toMatchObject({ code: "API_ERROR" });
    expect(catching(() => parseMicros("1.5"))).toMatchObject({ code: "API_ERROR" });
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

  it("refuses a total past safe-integer precision (a year in VND) with an AdmobctlError and a fix", () => {
    const fiveBillionVnd = 5_000_000_000 * 1_000_000;
    const err = catching(() => sumMicros([fiveBillionVnd, fiveBillionVnd]));
    expect(err).toBeInstanceOf(AdmobctlError);
    expect(err.message).toMatch(/precision/);
    expect(err.fix).toMatch(/--currency USD/);
  });

  it("refuses a sum that passes the limit on the way, even if it ends below it", () => {
    expect(() => sumMicros([Number.MAX_SAFE_INTEGER, 2, -2])).toThrow(AdmobctlError);
  });
});
