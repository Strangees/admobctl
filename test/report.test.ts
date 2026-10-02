import { describe, expect, it } from "vitest";
import { buildReportSpec, normalizeDimension, normalizeMetric, parseReport } from "../src/core/report.js";
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

  it("sorts by date when the report is a time series", () => {
    const spec = buildReportSpec("network", {
      dateRange: { startDate: { year: 2026, month: 9, day: 1 }, endDate: { year: 2026, month: 9, day: 2 } },
      dimensions: ["date"],
      metrics: ["impressions"],
    });
    expect(spec.sortConditions).toEqual([{ dimension: "DATE", order: "ASCENDING" }]);
  });
});
