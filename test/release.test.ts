/** Guards what a release ships: one version everywhere, and the open-source hygiene rules in AGENTS.md. */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
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
      claude: json("plugin/.claude-plugin/plugin.json").version,
      codex: json("plugin/.codex-plugin/plugin.json").version,
    }).toEqual({ lock: version, lockRoot: version, claude: version, codex: version });
  });

  it("is the version the committed bundle reports", () => {
    const out = execFileSync(process.execPath, ["plugin/dist/admobctl.mjs", "--version"], { cwd: root, encoding: "utf8" });
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

describe("directory listing", () => {
  it("points the icon at a committed image and the listing links at https URLs", () => {
    const manifest = JSON.parse(read("plugin/.claude-plugin/plugin.json")) as Record<string, unknown>;
    expect(tracked).toContain(`plugin/${String(manifest.icon).replace(/^\.\//, "")}`);
    for (const key of ["documentationUrl", "supportUrl", "privacyPolicyUrl"]) expect(manifest[key], key).toMatch(/^https:\/\//);
    expect(manifest.privacyPolicyUrl).toBe("https://github.com/Strangees/admobctl/blob/main/PRIVACY.md");
    expect(tracked).toContain("PRIVACY.md");
  });

  it("keeps CLAUDE.md out of the plugin folder, where it is not loaded and fails plugin validation", () => {
    expect(tracked.filter((f) => f.startsWith("plugin/") && f.endsWith("CLAUDE.md"))).toEqual([]);
  });
});

describe("plugin folder", () => {
  const files = tracked.filter((f) => f.startsWith("plugin/")).map((f) => f.slice("plugin/".length));

  it("is what both marketplaces install", () => {
    expect((JSON.parse(read(".claude-plugin/marketplace.json")) as { plugins: Array<{ source: string }> }).plugins[0]!.source).toBe("./plugin");
    expect(files).toEqual(expect.arrayContaining([".claude-plugin/plugin.json", ".codex-plugin/plugin.json", "dist/admobctl.mjs", "README.md", "LICENSE"]));
  });

  it("ships no package.json or lockfile, so installing the plugin runs no npm install", () => {
    expect(files.filter((f) => /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|\.npmrc)$/.test(f))).toEqual([]);
  });

  it("keeps every file except the bundle and images under the directory's 256 KiB read limit", () => {
    const big = files.filter((f) => f !== "dist/admobctl.mjs" && !/\.(png|svg)$/.test(f) && statSync(`${root}plugin/${f}`).size > 256 * 1024);
    expect(big).toEqual([]);
  });

  it("carries the project LICENSE and the data disclosure", () => {
    expect(read("plugin/LICENSE")).toBe(read("LICENSE"));
    expect(read("plugin/README.md")).toContain("## Data and privacy");
  });
});
