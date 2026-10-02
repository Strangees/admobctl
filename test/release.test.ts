/** Guards what a release ships: one version everywhere, and the open-source hygiene rules in .claude/CLAUDE.md. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const json = (path: string) => JSON.parse(read(path)) as { version: string; packages?: Record<string, { version: string }> };
const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);

describe("release version", () => {
  const version = json("package.json").version;

  it("is the same in package.json, the lockfile and both plugin manifests", () => {
    const lock = json("package-lock.json");
    expect({
      lock: lock.version,
      lockRoot: lock.packages![""]!.version,
      claude: json(".claude-plugin/plugin.json").version,
      codex: json(".codex-plugin/plugin.json").version,
    }).toEqual({ lock: version, lockRoot: version, claude: version, codex: version });
  });

  it("is the version the committed bundle reports", () => {
    const out = execFileSync(process.execPath, ["dist/admobctl.mjs", "--version"], { cwd: root, encoding: "utf8" });
    expect(out.trim()).toBe(version);
  });
});

describe("open-source hygiene", () => {
  /** Tracked text files with every match of `re`; binary files are skipped. */
  function matches(re: RegExp): string[] {
    return tracked.flatMap((file) => {
      const text = read(file);
      return text.includes("\0") ? [] : [...text.matchAll(re)].map((m) => `${file}: ${m[0]}`);
    });
  }

  it("has only placeholder publisher IDs in committed files", () => {
    expect(matches(/pub-\d{16}/g).filter((m) => !/pub-0{14}\d{2}$/.test(m))).toEqual([]);
  });

  it("has only example.com email addresses in committed files", () => {
    const emails = matches(/[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/gi);
    expect(emails.filter((m) => !/@(?:[\w-]+\.)*example\.(?:com|org)$|noreply@anthropic\.com$/i.test(m))).toEqual([]);
  });

  it("keeps recorded API responses and product requirements out of git", () => {
    expect(tracked.filter((f) => f.startsWith("test/fixtures/private/") && !f.endsWith(".gitkeep"))).toEqual([]);
    expect(tracked.filter((f) => /(^|\/)PRD[^/]*\.md$/.test(f))).toEqual([]);
  });
});
