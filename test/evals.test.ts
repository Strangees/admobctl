/** Guards plugin/evals/: a correct answer built from the mocked MCP results must be able to pass every grader. */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const evals = new URL("../plugin/evals/", import.meta.url);
const mocks = new URL("mocks/admobctl/", evals);
const TOOL_PREFIX = "mcp__plugin_admobctl_admobctl__";

/** The flat `key: value` front matter of a case or grader file. Quoted values are unquoted. */
function frontMatter(file: URL): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---/.exec(readFileSync(file, "utf8"));
  const out: Record<string, string> = {};
  for (const line of m?.[1]?.split("\n") ?? []) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const raw = kv[2]!.trim();
    out[kv[1]!] = raw.startsWith('"') ? (JSON.parse(raw) as string) : raw.startsWith("'") ? raw.slice(1, -1).replaceAll("''", "'") : raw;
  }
  return out;
}

const cases = readdirSync(evals, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name !== "mocks" && e.name !== "results")
  .map((e) => {
    const dir = new URL(`${e.name}/graders/`, evals);
    const graders = readdirSync(dir).map((f) => ({ file: f, ...frontMatter(new URL(f, dir)) }) as Record<string, string> & { file: string });
    return { name: e.name, graders };
  });

const mock = (tool: string) => readFileSync(new URL(`${tool.slice(TOOL_PREFIX.length)}.md`, mocks), "utf8");

describe("plugin evals", () => {
  it("finds the cases", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const c of cases) {
    const tools = c.graders.filter((g) => g.type === "tool_used").map((g) => g.tool!);

    it(`${c.name}: tool_used graders name admobctl tools that have a mock`, () => {
      for (const tool of tools) {
        expect(tool.startsWith(TOOL_PREFIX), tool).toBe(true);
        expect(() => mock(tool), tool).not.toThrow();
      }
    });

    for (const g of c.graders.filter((g) => g.type === "regex")) {
      it(`${c.name}: regex grader ${g.file} matches the mocked tool results`, () => {
        expect(tools.length, "a case with a regex grader needs a tool_used grader to say which mock it reads").toBeGreaterThan(0);
        const re = new RegExp(g.pattern!);
        expect(tools.some((t) => re.test(mock(t))), `${g.pattern} matches none of ${tools.join(", ")}`).toBe(true);
      });
    }
  }
});
