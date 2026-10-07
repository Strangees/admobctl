import { describe, expect, it } from "vitest";
import { buildReportSpec, compatibleMetrics, normalizeDimension, normalizeMetric, parseReport } from "../src/core/report.js";
import { AdmobctlError } from "../src/core/errors.js";
import { fixture } from "./helpers.js";

describe("parseReport", () => {
  const report = parseReport(fixture<unknown[]>("network-report-by-app.json"));

  it("reads currency, time zone and range from the header", () => {
    expect(report.currency).toBe("NOK");
    expect(report.timeZone).toBe("Europe/Oslo");
    expect(report.dateRange?.startDate).toEqual({ year: 2026, month: 9, day: 1 });
  });

  it("keeps earnings as integer micros", () => {
    expect(report.rows[0]!.metrics.ESTIMATED_EARNINGS).toBe(60_125_000);
    expect(report.rows[0]!.metrics.IMPRESSION_RPM).toBe(5_010_416);
  });

  it("parses integer and double metrics", () => {
    expect(report.rows[1]!.metrics.IMPRESSIONS).toBe(8000);
    expect(report.rows[1]!.metrics.MATCH_RATE).toBe(0.25);
  });

  it("keeps dimension values and labels", () => {
    expect(report.rows[2]!.dimensions.APP).toEqual({
      value: "ca-app-pub-0000000000000001~3333333333",
      label: "Sample Timer: Focus & Breaks",
    });
  });

  it("reads the footer", () => {
    expect(report.rows).toHaveLength(3);
    expect(report.matchingRowCount).toBe(3);
    expect(report.warnings).toEqual([]);
  });

  it("accepts an empty report (header and footer only)", () => {
    const r = parseReport([{ header: { localizationSettings: { currencyCode: "NOK" } } }, { footer: {} }]);
    expect(r.rows).toEqual([]);
  });

  it("accepts an empty campaign report (an object without rows)", () => {
    expect(parseReport({}).rows).toEqual([]);
  });

  it("fails on an error chunk in the stream instead of returning the rows before it as the whole report", () => {
    const [header, row] = fixture<unknown[]>("network-report-by-app.json");
    const raw = [header, row, { error: { code: 500, message: "Internal error encountered.", status: "INTERNAL" } }];
    expect(() => parseReport(raw)).toThrow(AdmobctlError);
    expect(() => parseReport(raw)).toThrow(
      expect.objectContaining({ code: "API_ERROR", status: 500, message: expect.stringContaining("Internal error encountered.") }),
    );
  });

  it("diagnoses an error object returned in place of a report", () => {
    expect(() => parseReport({ error: { code: 403, message: "The caller does not have permission", status: "PERMISSION_DENIED" } })).toThrow(
      expect.objectContaining({ code: "PERMISSION_DENIED" }),
    );
  });

  it.each([
    ["text", "<html>Sign in to Wi-Fi</html>"],
    ["an empty body", undefined],
    ["null", null],
    ["a null chunk", [{ header: {} }, null, { footer: {} }]],
    ["a number chunk", [{ header: {} }, 7]],
    ["a null campaign row", { rows: [null] }],
    ["a number campaign row", { rows: [{ dimensionValues: {}, metricValues: {} }, 7] }],
  ])("rejects %s with a readable error, not a TypeError", (_name, raw) => {
    expect(() => parseReport(raw)).toThrow(expect.objectContaining({ code: "API_ERROR", message: expect.stringMatching(/report/i) }));
  });
});

describe("normalizeDimension / normalizeMetric", () => {
  it("accepts friendly kebab-case names", () => {
    expect(normalizeDimension("ad-unit", "network")).toBe("AD_UNIT");
    expect(normalizeDimension("App", "network")).toBe("APP");
    expect(normalizeDimension("ad-source", "mediation")).toBe("AD_SOURCE");
    expect(normalizeMetric("earnings", "network")).toBe("ESTIMATED_EARNINGS");
    expect(normalizeMetric("requests", "network")).toBe("AD_REQUESTS");
    expect(normalizeMetric("rpm", "network")).toBe("IMPRESSION_RPM");
    expect(normalizeMetric("ecpm", "mediation")).toBe("OBSERVED_ECPM");
  });

  it("rejects names the report type does not support, listing valid ones", () => {
    expect(() => normalizeDimension("ad-source", "network")).toThrow(/Valid: .*ad-unit/);
    expect(() => normalizeMetric("show-rate", "mediation")).toThrow(/not supported/);
  });
});

describe("buildReportSpec", () => {
  it("builds a network report spec with filters and row cap", () => {
    const spec = buildReportSpec("network", {
      dateRange: {
        startDate: { year: 2026, month: 9, day: 1 },
        endDate: { year: 2026, month: 9, day: 30 },
      },
      dimensions: ["app", "country"],
      metrics: ["earnings", "impressions"],
      filters: { country: ["NO", "SE"] },
      maxRows: 500,
    });
    expect(spec).toEqual({
      dateRange: {
        startDate: { year: 2026, month: 9, day: 1 },
        endDate: { year: 2026, month: 9, day: 30 },
      },
      dimensions: ["APP", "COUNTRY"],
      metrics: ["ESTIMATED_EARNINGS", "IMPRESSIONS"],
      dimensionFilters: [{ dimension: "COUNTRY", matchesAny: { values: ["NO", "SE"] } }],
      sortConditions: [{ metric: "ESTIMATED_EARNINGS", order: "DESCENDING" }],
      maxReportRows: 500,
    });
  });

  it("rejects a row cap outside the API's 1–100000", () => {
    const range = { startDate: { year: 2026, month: 9, day: 1 }, endDate: { year: 2026, month: 9, day: 30 } };
    const spec = (maxRows: number) => buildReportSpec("network", { dateRange: range, dimensions: ["app"], metrics: ["earnings"], maxRows });
    expect(spec(100_000).maxReportRows).toBe(100_000);
    for (const bad of [100_001, 150_000, 0, -1, 2.5]) {
      expect(() => spec(bad)).toThrow(expect.objectContaining({ code: "USAGE", message: expect.stringContaining("100000") }));
    }
  });

  it("sorts by date when the report is a time series", () => {
    const spec = buildReportSpec("network", {
      dateRange: { startDate: { year: 2026, month: 9, day: 1 }, endDate: { year: 2026, month: 9, day: 2 } },
      dimensions: ["date"],
      metrics: ["impressions"],
    });
    expect(spec.sortConditions).toEqual([{ dimension: "DATE", order: "ASCENDING" }]);
  });

  const sept = { startDate: { year: 2026, month: 9, day: 1 }, endDate: { year: 2026, month: 9, day: 30 } };

  it("asks for a currency conversion via localizationSettings", () => {
    const spec = buildReportSpec("network", { dateRange: sept, dimensions: ["app"], metrics: ["earnings"], currency: "usd" });
    expect(spec.localizationSettings).toEqual({ currencyCode: "USD" });
  });

  it("rejects a currency that is not an ISO 4217 code", () => {
    expect(() => buildReportSpec("network", { dateRange: sept, dimensions: ["app"], metrics: ["earnings"], currency: "dollars" })).toThrow(
      /ISO 4217/,
    );
  });

  it("rejects more than one time dimension", () => {
    expect(() => buildReportSpec("network", { dateRange: sept, dimensions: ["date", "month"], metrics: ["earnings"] })).toThrow(
      /one time dimension/,
    );
  });

  it("rejects ad-type with requests, match rate or RPM", () => {
    expect(() => buildReportSpec("network", { dateRange: sept, dimensions: ["ad-type"], metrics: ["earnings", "requests", "rpm"] })).toThrow(
      /ad-type.*requests, rpm/,
    );
    expect(() => buildReportSpec("network", { dateRange: sept, dimensions: ["ad-type"], metrics: ["earnings", "impressions"] })).not.toThrow();
  });
});

describe("compatibleMetrics", () => {
  it("drops default metrics that ad-type cannot be combined with", () => {
    const r = compatibleMetrics("network", ["AD_TYPE"], ["ESTIMATED_EARNINGS", "AD_REQUESTS", "MATCH_RATE", "IMPRESSIONS", "IMPRESSION_RPM"]);
    expect(r.kept).toEqual(["ESTIMATED_EARNINGS", "IMPRESSIONS"]);
    expect(r.dropped).toEqual(["AD_REQUESTS", "MATCH_RATE", "IMPRESSION_RPM"]);
  });

  it("drops earnings-based defaults for version dimensions", () => {
    const r = compatibleMetrics("mediation", ["GMA_SDK_VERSION"], ["ESTIMATED_EARNINGS", "AD_REQUESTS", "OBSERVED_ECPM"]);
    expect(r.kept).toEqual(["AD_REQUESTS"]);
    expect(r.dropped).toEqual(["ESTIMATED_EARNINGS", "OBSERVED_ECPM"]);
  });

  it("keeps everything for ordinary dimensions", () => {
    const r = compatibleMetrics("network", ["APP", "COUNTRY"], ["ESTIMATED_EARNINGS", "AD_REQUESTS"]);
    expect(r).toEqual({ kept: ["ESTIMATED_EARNINGS", "AD_REQUESTS"], dropped: [] });
  });
});
