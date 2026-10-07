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

const graphemes = new Intl.Segmenter();
/** East Asian Wide and Fullwidth blocks (Unicode UAX #11): Hangul, CJK, kana, Yi, fullwidth forms. */
const WIDE =
  /^[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6\u{1b000}-\u{1b2ff}\u{20000}-\u{3fffd}]/u;

/** Terminal columns a string takes: per grapheme, 2 for wide characters and emoji, 0 for combining marks and zero-width ones. */
function displayWidth(s: string): number {
  if (/^[\x20-\x7e]*$/.test(s)) return s.length;
  let width = 0;
  for (const { segment } of graphemes.segment(s)) {
    if (/^[\p{Mn}\p{Me}\p{Cf}\p{Cc}]+$/u.test(segment)) continue;
    width += /\p{Emoji_Presentation}|\ufe0f/u.test(segment) || WIDE.test(segment) ? 2 : 1;
  }
  return width;
}

function renderTable({ columns, rows, footer = [] }: TableData, notes: string[]): string {
  const lines: string[] = [];
  if (rows.length === 0) lines.push("(no rows)");
  else {
    const grid = rows.map((r) => columns.map((c) => cell(r[c.key])));
    const foot = footer.map((r) => columns.map((c) => cell(r[c.key])));
    const widths = columns.map((c, i) => Math.max(displayWidth(c.label), ...[...grid, ...foot].map((g) => displayWidth(g[i]!))));
    const fmt = (vals: string[]) =>
      vals
        .map((v, i) => {
          const pad = " ".repeat(Math.max(0, widths[i]! - displayWidth(v)));
          return columns[i]!.align === "right" ? pad + v : v + pad;
        })
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
  return v.replace(/\|/g, "\\|").replace(/\r\n|\r|\n/g, " ");
}

/** A note as blockquote lines. A note that spans lines (a write plan's request body) keeps its layout in a code fence. */
function mdNote(note: string): string[] {
  const lines = note.split(/\r\n|\r|\n/);
  if (lines.length === 1) return [`> ${note}`];
  const fence = "`".repeat(Math.max(3, ...[...note.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return [fence, ...lines, fence].map((l) => (l ? `> ${l}` : ">"));
}

function renderMarkdown({ columns, rows, footer = [] }: TableData, notes: string[]): string {
  const bold = (v: string) => (v ? `**${v}**` : v);
  const lines = [
    `| ${columns.map((c) => mdEscape(c.label)).join(" | ")} |`,
    `| ${columns.map((c) => (c.align === "right" ? "---:" : "---")).join(" | ")} |`,
    ...rows.map((r) => `| ${columns.map((c) => mdEscape(cell(r[c.key]))).join(" | ")} |`),
    ...footer.map((r) => `| ${columns.map((c) => bold(mdEscape(cell(r[c.key])))).join(" | ")} |`),
  ];
  if (notes.length) lines.push("", ...notes.flatMap(mdNote));
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
