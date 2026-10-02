export type OutputFormat = "json" | "table" | "csv" | "markdown";
export const OUTPUT_FORMATS: OutputFormat[] = ["json", "table", "csv", "markdown"];

export interface Column {
  key: string;
  label: string;
  align?: "left" | "right";
}

export interface TableData {
  columns: Column[];
  rows: Array<Record<string, unknown>>;
  /** Summary rows (e.g. totals) shown in table and markdown output, never in CSV. */
  footer?: Array<Record<string, unknown>>;
}

/** What every command produces. `data` is the JSON view; `table` the human view. */
export interface Output {
  data: unknown;
  table: TableData;
  notes?: string[];
}

export function defaultFormat(isTTY: boolean | undefined): OutputFormat {
  return isTTY ? "table" : "json";
}

function cell(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

function renderTable({ columns, rows, footer = [] }: TableData, notes: string[]): string {
  const lines: string[] = [];
  if (rows.length === 0) lines.push("(no rows)");
  else {
    const grid = rows.map((r) => columns.map((c) => cell(r[c.key])));
    const foot = footer.map((r) => columns.map((c) => cell(r[c.key])));
    const widths = columns.map((c, i) => Math.max(c.label.length, ...[...grid, ...foot].map((g) => g[i]!.length)));
    const fmt = (vals: string[]) =>
      vals
        .map((v, i) => (columns[i]!.align === "right" ? v.padStart(widths[i]!) : v.padEnd(widths[i]!)))
        .join("  ")
        .trimEnd();
    lines.push(fmt(columns.map((c) => c.label)));
    lines.push(widths.map((w) => "─".repeat(w)).join("  "));
    for (const g of grid) lines.push(fmt(g));
    if (foot.length) {
      lines.push(widths.map((w) => "─".repeat(w)).join("  "));
      for (const g of foot) lines.push(fmt(g));
    }
  }
  if (notes.length) lines.push("", ...notes);
  return `${lines.join("\n")}\n`;
}

function csvField(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function renderCsv({ columns, rows }: TableData): string {
  const lines = [columns.map((c) => csvField(c.label)).join(",")];
  for (const r of rows) lines.push(columns.map((c) => csvField(cell(r[c.key]))).join(","));
  return `${lines.join("\n")}\n`;
}

function mdEscape(v: string): string {
  return v.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function renderMarkdown({ columns, rows, footer = [] }: TableData, notes: string[]): string {
  const bold = (v: string) => (v ? `**${v}**` : v);
  const lines = [
    `| ${columns.map((c) => mdEscape(c.label)).join(" | ")} |`,
    `| ${columns.map((c) => (c.align === "right" ? "---:" : "---")).join(" | ")} |`,
    ...rows.map((r) => `| ${columns.map((c) => mdEscape(cell(r[c.key]))).join(" | ")} |`),
    ...footer.map((r) => `| ${columns.map((c) => bold(mdEscape(cell(r[c.key])))).join(" | ")} |`),
  ];
  if (notes.length) lines.push("", ...notes.map((n) => `> ${n}`));
  return `${lines.join("\n")}\n`;
}

export function render(out: Output, format: OutputFormat): string {
  const notes = out.notes ?? [];
  switch (format) {
    case "json":
      return `${JSON.stringify(out.data, null, 2)}\n`;
    case "csv":
      return renderCsv(out.table);
    case "markdown":
      return renderMarkdown(out.table, notes);
    case "table":
      return renderTable(out.table, notes);
  }
}

/** Tab-separated, for pasting straight into a spreadsheet. Tabs/newlines in cells become spaces. */
export function renderTsv({ columns, rows }: TableData): string {
  const clean = (v: string) => v.replace(/[\t\r\n]+/g, " ");
  const lines = [columns.map((c) => clean(c.label)).join("\t")];
  for (const r of rows) lines.push(columns.map((c) => clean(cell(r[c.key]))).join("\t"));
  return `${lines.join("\n")}\n`;
}
