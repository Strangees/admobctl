/**
 * Enforces the layering rule in AGENTS.md: src/cli and src/mcp never import each other, directly or through another
 * module, and the shared layers (src/core, src/output) import neither.
 */
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

/**
 * Relative module specifiers from static imports, side-effect imports, re-exports (`export … from`), and dynamic
 * `import()` or `require()` with a string or template literal. A dynamic import whose specifier is computed (a variable,
 * or a template literal with `${…}`) comes back in `computed`, because no static check can follow it.
 */
function imports(code: string): { specifiers: string[]; computed: string[] } {
  const specifiers = [...code.matchAll(/(?:\bfrom\s*|\bimport\s+)["']([^"']+)["']/g)].map((m) => m[1]!);
  const computed: string[] = [];
  for (const m of code.matchAll(/\b(?:import|require)\s*\(\s*([^)]*?)\s*\)/g)) {
    const literal = /^(["'])([^"']*)\1$/.exec(m[1]!) ?? /^(`)([^`$]*)`$/.exec(m[1]!);
    if (literal) specifiers.push(literal[2]!);
    else computed.push(m[0]);
  }
  return { specifiers: specifiers.filter((s) => s.startsWith(".")), computed };
}

const files = tsFiles(src);
const layer = (file: string) => relative(src, file).split(sep)[0]!;
const parsed = new Map(files.map((f) => [f, imports(readFileSync(f, "utf8"))]));

/** The src file a relative specifier points at (`./x.js` is `./x.ts` on disk). */
function target(file: string, specifier: string): string {
  const p = resolve(dirname(file), specifier);
  return [p.replace(/\.js$/, ".ts"), p, `${p}.ts`, join(p, "index.ts")].find((c) => files.includes(c)) ?? p;
}

const graph = new Map(files.map((f) => [f, parsed.get(f)!.specifiers.map((s) => target(f, s))]));

/** Imports from files in layer `from` that land in layer `to`. */
function crossImports(from: string, to: string): string[] {
  return files
    .filter((f) => layer(f) === from)
    .flatMap((f) => graph.get(f)!.filter((t) => layer(t) === to).map((t) => `${relative(src, f)} imports ${relative(src, t)}`));
}

/** Files in layer `to` that files in layer `from` reach by following imports through any other modules. */
function reaches(from: string, to: string): string[] {
  const seen = new Set<string>();
  const queue = files.filter((f) => layer(f) === from);
  while (queue.length) {
    for (const t of graph.get(queue.pop()!) ?? []) {
      if (seen.has(t)) continue;
      seen.add(t);
      queue.push(t);
    }
  }
  return [...seen].filter((f) => layer(f) === to).map((f) => relative(src, f));
}

describe("layering", () => {
  it("finds source files in every layer", () => {
    for (const l of ["cli", "mcp", "core", "output"]) expect(files.filter((f) => layer(f) === l).length, l).toBeGreaterThan(0);
  });

  it("src/cli does not import from src/mcp", () => {
    expect(crossImports("cli", "mcp")).toEqual([]);
  });

  it("src/mcp does not import from src/cli", () => {
    expect(crossImports("mcp", "cli")).toEqual([]);
  });

  it("src/core and src/output import neither src/cli nor src/mcp", () => {
    expect(["core", "output"].flatMap((from) => [...crossImports(from, "cli"), ...crossImports(from, "mcp")])).toEqual([]);
  });

  it("src/cli and src/mcp do not reach each other through other modules", () => {
    expect(reaches("cli", "mcp")).toEqual([]);
    expect(reaches("mcp", "cli")).toEqual([]);
  });

  it("has no dynamic import with a computed specifier, which these checks could not follow", () => {
    expect(files.flatMap((f) => parsed.get(f)!.computed.map((c) => `${relative(src, f)}: ${c}`))).toEqual([]);
  });
});
