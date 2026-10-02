import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli/program.js";
import type { TokenProvider } from "../src/core/auth/types.js";
import { fakeFetch, fixture, jsonResponse, noSleep } from "./helpers.js";

const token: TokenProvider = { mode: "adc", getToken: async () => "t", quotaProject: () => "qp" };

async function cli(args: string[], opts: { isTTY?: boolean; dir?: string } = {}) {
  const f = fakeFetch({
    "GET /v1/accounts?": () => jsonResponse(fixture("accounts.json")),
    "GET /apps": (c) => jsonResponse(fixture(c.url.includes("pageToken=page2") ? "apps-page2.json" : "apps-page1.json")),
    "GET /adUnits": () => jsonResponse(fixture("ad-units.json")),
    "POST /networkReport:generate": (c) => {
      const dims = (c.body as { reportSpec: { dimensions: string[] } }).reportSpec.dimensions;
      return jsonResponse(fixture(dims.includes("MONTH") ? "network-report-by-month-app.json" : "network-report-by-app.json"));
    },
    "POST /tokeninfo": () => jsonResponse({ scope: "https://www.googleapis.com/auth/admob.readonly", expires_in: "3000" }),
  });
  let stdout = "";
  let stderr = "";
  const code = await run(["node", "admobctl", ...args], {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    isTTY: opts.isTTY ?? false,
    service: {
      configDir: opts.dir ?? mkdtempSync(join(tmpdir(), "admobctl-cli-")),
      tokenProvider: token,
      fetch: f.fetch,
      sleep: noSleep,
      now: () => new Date("2026-10-02T08:00:00Z"),
    },
  });
  return { code, stdout, stderr, calls: f.calls };
}

describe("cli", () => {
  it("prints JSON when piped", async () => {
    const r = await cli(["apps", "list"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).map((a: { alias: string }) => a.alias)).toContain("example-quiz-ios");
  });

  it("prints a table on a TTY", async () => {
    const r = await cli(["apps", "list"], { isTTY: true });
    expect(r.stdout).toMatch(/^Alias\s+Name\s+Platform/);
    expect(r.stdout).toContain("example-quiz-android");
  });

  it("lists accounts", async () => {
    const r = await cli(["accounts", "list", "-o", "csv"]);
    expect(r.stdout).toBe("Publisher ID,Currency,Time zone\npub-0000000000000001,NOK,Europe/Oslo\n");
  });

  it("lists ad units for one app", async () => {
    const r = await cli(["ad-units", "list", "--app", "example-quiz-ios", "--output", "json"]);
    expect(JSON.parse(r.stdout)).toHaveLength(2);
  });

  it("runs a network report as CSV with money and rates formatted", async () => {
    const r = await cli(["report", "network", "--from", "2026-09", "--to", "2026-09", "--by", "app", "--metrics", "earnings,impressions,match-rate", "-o", "csv"]);
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines[0]).toBe("App,Earnings (NOK),Impressions,Match rate");
    expect(lines[1]).toBe("example-quiz-ios,60.13,12000,75.0%");
  });

  it("passes repeatable --filter values through", async () => {
    const r = await cli(["report", "network", "--from", "2026-09", "--to", "2026-09", "--by", "country", "--filter", "country=NO,SE"]);
    const body = r.calls.find((c) => c.url.includes("networkReport"))!.body as { reportSpec: { dimensionFilters: unknown } };
    expect(body.reportSpec.dimensionFilters).toEqual([{ dimension: "COUNTRY", matchesAny: { values: ["NO", "SE"] } }]);
  });

  it("returns exit code 2 and a readable message for usage errors", async () => {
    const r = await cli(["report", "network", "--from", "2026/09", "--to", "2026-09", "--by", "app"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("YYYY-MM");
    expect(r.stdout).toBe("");
  });

  it("runs auth doctor and reports each check", async () => {
    const r = await cli(["auth", "doctor"], { isTTY: true });
    expect(r.stdout, r.stdout + r.stderr).toMatch(/✓ credentials/);
    expect(r.stdout).toMatch(/✓ api/);
    expect(r.stdout).not.toMatch(/✗/);
    expect(r.code).toBe(0);
  });

  it("auth status reports the account other commands use (--account beats the profile)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "admobctl-cli-"));
    expect((await cli(["config", "set", "account", "pub-A"], { dir })).code).toBe(0);
    const fromProfile = await cli(["auth", "status", "-o", "json"], { dir });
    expect(fromProfile.code, fromProfile.stderr).toBe(0);
    expect(JSON.parse(fromProfile.stdout).account).toBe("pub-A");
    const overridden = await cli(["--account", "pub-B", "auth", "status", "-o", "json"], { dir });
    expect(overridden.code, overridden.stderr).toBe(0);
    expect(JSON.parse(overridden.stdout).account).toBe("pub-B");
    expect(overridden.calls.some((c) => c.url.includes("/v1/accounts"))).toBe(false);
  });

  it("sets and reads config values", async () => {
    const dir = mkdtempSync(join(tmpdir(), "admobctl-cli-"));
    expect((await cli(["config", "set", "finance.revenueAccount", "3100"], { dir })).code).toBe(0);
    const r = await cli(["config", "get"], { dir });
    expect(JSON.parse(r.stdout).finance.revenueAccount).toBe("3100");
  });

  it("prints finance month as a table with the estimate label", async () => {
    const r = await cli(["finance", "month", "2026-09"], { isTTY: true });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/example-quiz-ios\s+Example Quiz\s+IOS\s+60\.13/);
    expect(r.stdout).toMatch(/Total\s+.*102\.45/);
    expect(r.stdout).toMatch(/reconcile against AdMob Payments \(finalized\)/);
  });

  it("prints finance journal rows as paste-ready TSV", async () => {
    const r = await cli(["finance", "month", "2026-09", "--as", "journal"]);
    const lines = r.stdout.trim().split("\n");
    expect(lines[0]).toBe("Bilag\tDato\tKilde\tBeskrivelse\tKonto\tKontonavn\tDebet\tKredit\tMVA-behandling\tMotpart\tStatus\tMerknad");
    expect(lines[1]!.split("\t").slice(1, 8)).toEqual(["2026-09-30", "AdMob (admobctl)", "AdMob opptjent september 2026", "1509", "Fordring AdMob", "102.45", ""]);
    expect(lines).toHaveLength(5);
  });

  it("supports --as csv and --as json for finance month", async () => {
    const csv = await cli(["finance", "month", "2026-09", "--as", "csv"]);
    expect(csv.stdout.split("\n")[0]).toBe("App,Name,Platform,Earnings (NOK)");
    const json = await cli(["finance", "month", "2026-09", "--as", "json"], { isTTY: true });
    expect(JSON.parse(json.stdout).total).toBe(102.45);
  });

  it("prints a finance range by month", async () => {
    const r = await cli(["finance", "range", "--from", "2026-07", "--to", "2026-09", "-o", "csv"]);
    expect(r.stdout).toBe("Month,Earnings (NOK),Complete\n2026-07,65.00,yes\n2026-08,78.08,yes\n2026-09,102.45,yes\n");
  });

  it("runs insights with --last", async () => {
    const r = await cli(["insights", "--last", "30d", "--by", "app", "-o", "json"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.from).toBe("2026-09-02");
    expect(j.summary.length).toBeGreaterThan(0);
  });

  it("rejects a malformed --last", async () => {
    const r = await cli(["insights", "--last", "30"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--last/);
  });

  it("prints the version", async () => {
    const r = await cli(["--version"]);
    expect(r.stdout).toMatch(/\d+\.\d+\.\d+/);
    expect(r.code).toBe(0);
  });
});
