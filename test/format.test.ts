import { describe, expect, it } from "vitest";
import { defaultFormat, render, type Output } from "../src/output/format.js";

const out: Output = {
  data: { rows: [{ app: "quiz-ios", earnings: 60.13 }] },
  table: {
    columns: [
      { key: "app", label: "App" },
      { key: "earnings", label: "Earnings", align: "right" },
    ],
    rows: [
      { app: "quiz-ios", earnings: "60.13" },
      { app: 'say "hi", ok', earnings: "1.00" },
    ],
  },
  notes: ["Estimated earnings."],
};

describe("render", () => {
  it("json prints the structured data, not the table", () => {
    expect(JSON.parse(render(out, "json"))).toEqual(out.data);
  });

  it("table aligns columns and appends notes", () => {
    const text = render(out, "table");
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/^App\s+Earnings$/);
    expect(lines[2]).toMatch(/^quiz-ios\s+60\.13$/);
    expect(lines[0]!.length).toBe(lines[2]!.length);
    expect(text).toContain("Estimated earnings.");
  });

  it("csv quotes per RFC 4180 and leaves notes out", () => {
    expect(render(out, "csv")).toBe('App,Earnings\nquiz-ios,60.13\n"say ""hi"", ok",1.00\n');
  });

  it("markdown renders a pipe table with right-aligned numbers", () => {
    const md = render(out, "markdown");
    expect(md).toContain("| App | Earnings |");
    expect(md).toContain("| --- | ---: |");
    expect(md).toContain("> Estimated earnings.");
  });

  it("shows footer rows in table and markdown but keeps CSV data-only", () => {
    const withTotal: Output = { ...out, table: { ...out.table, footer: [{ app: "Total", earnings: "61.13" }] } };
    expect(render(withTotal, "table")).toMatch(/\nTotal\s+61\.13\n/);
    expect(render(withTotal, "markdown")).toContain("| **Total** | **61.13** |");
    expect(render(withTotal, "csv")).not.toContain("Total");
  });

  it("table prints a friendly message for no rows", () => {
    expect(render({ ...out, table: { ...out.table, rows: [] } }, "table")).toContain("(no rows)");
  });
});

describe("defaultFormat", () => {
  it("is table on a TTY and json when piped", () => {
    expect(defaultFormat(true)).toBe("table");
    expect(defaultFormat(false)).toBe("json");
  });
});
