/** Enforces the layering rule in AGENTS.md: src/cli and src/mcp never import each other. */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = fileURLToPath(new URL("../src", import.meta.url));

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return tsFiles(p);
    return e.name.endsWith(".ts") ? [p] : [];
  });
}

/** Relative module specifiers from static imports, re-exports and dynamic imports. */
function specifiers(code: string): string[] {
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;
  return [...code.matchAll(re)].map((m) => m[1]!).filter((s) => s.startsWith("."));
}

function crossImports(from: "cli" | "mcp", to: "cli" | "mcp"): string[] {
  const target = join(src, to) + sep;
  return tsFiles(join(src, from)).flatMap((file) =>
    specifiers(readFileSync(file, "utf8"))
      .filter((s) => (resolve(dirname(file), s) + sep).startsWith(target))
      .map((s) => `${relative(src, file)} imports "${s}"`),
  );
}

describe("layering", () => {
  it("finds source files in both layers", () => {
    expect(tsFiles(join(src, "cli")).length).toBeGreaterThan(0);
    expect(tsFiles(join(src, "mcp")).length).toBeGreaterThan(0);
  });

  it("src/cli does not import from src/mcp", () => {
    expect(crossImports("cli", "mcp")).toEqual([]);
  });

  it("src/mcp does not import from src/cli", () => {
    expect(crossImports("mcp", "cli")).toEqual([]);
  });
});
