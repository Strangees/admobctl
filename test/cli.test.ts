import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli/program.js";
import { reportView } from "../src/cli/views.js";
import type { ReportResult } from "../src/core/service.js";
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
      if (dims.includes("GMA_SDK_VERSION")) return jsonResponse(fixture("network-report-by-sdk-version.json"));
      if (dims.includes("SERVING_RESTRICTION")) return jsonResponse(fixture("network-report-by-serving-restriction.json"));
      return jsonResponse(fixture(dims.includes("MONTH") ? "network-report-by-month-app.json" : "network-report-by-app.json"));
    },
    "POST /mediationReport:generate": () => jsonResponse(fixture("mediation-report-waterfall.json")),
    "GET /v1beta/accounts/pub-0000000000000001/adSources?": () => jsonResponse(fixture("ad-sources.json")),
    "GET /adSources/1000000000000000001/adapters": () => jsonResponse(fixture("adapters.json")),
    "GET /v1beta/accounts/pub-0000000000000001/mediationGroups": () => jsonResponse(fixture("mediation-groups.json")),
    "GET /adUnits/9000000001/adUnitMappings": () => jsonResponse(fixture("ad-unit-mappings.json")),
    "POST /campaignReport:generate": () => jsonResponse(fixture("campaign-report.json")),
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

  it("fails clearly when no MCP server is wired in", async () => {
    const r = await cli(["mcp"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("mcp command is not available");
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

  it("notes a possibly truncated report when the matching row count is unknown", () => {
    const r: ReportResult = {
      kind: "network",
      account: "pub-0000000000000001",
      from: "2026-09-01",
      to: "2026-09-30",
      dimensions: ["country"],
      metrics: ["earnings"],
      rows: [{ country: "C0" }, { country: "C1" }],
      truncated: true,
      warnings: [],
      notices: [],
    };
    const notes = reportView(r).notes ?? [];
    expect(notes.join("\n")).toContain("Truncated: showing 2 rows; more may exist.");
    expect(notes.join("\n")).not.toContain("undefined");
  });

  it("passes --currency to report and insights", async () => {
    const r = await cli(["report", "network", "--from", "2026-09", "--by", "app", "--currency", "usd"]);
    expect(r.code, r.stderr).toBe(0);
    const body = r.calls.find((c) => c.url.includes("networkReport"))!.body as { reportSpec: { localizationSettings: unknown } };
    expect(body.reportSpec.localizationSettings).toEqual({ currencyCode: "USD" });
    const ins = await cli(["insights", "--last", "30d", "--by", "app", "--currency", "EUR"]);
    expect(ins.code, ins.stderr).toBe(0);
    for (const c of ins.calls.filter((c) => c.url.includes("networkReport"))) {
      expect((c.body as { reportSpec: { localizationSettings: unknown } }).reportSpec.localizationSettings).toEqual({ currencyCode: "EUR" });
    }
  });

  it("prints admobctl notices under a report table", async () => {
    const r = await cli(["report", "network", "--from", "2026-10-01", "--to", "2026-10-02", "--by", "app"], { isTTY: true });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Includes today/);
  });

  it("rejects incompatible report combinations with exit code 2", async () => {
    const r = await cli(["report", "network", "--from", "2026-09", "--by", "date,month"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/one time dimension/);
  });

  it("shows each app's approval state and flags apps that need action", async () => {
    const r = await cli(["apps", "list"], { isTTY: true });
    expect(r.stdout).toMatch(/Approval/);
    expect(r.stdout).toMatch(/example-quiz-ios .*approved/);
    expect(r.stdout).not.toMatch(/need action/);
  });

  it("analyze versions prints each SDK version with its share, match and show rate", async () => {
    const r = await cli(["analyze", "versions", "--by", "sdk", "--last", "30d"], { isTTY: true });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Platform\s+SDK version\s+Requests/);
    expect(r.stdout).toMatch(/iOS\s+ios-11\.12\.0\s+20000\s+20\.0%\s+90\.0%\s+38\.9%/);
    expect(r.stdout).toMatch(/show rate 38\.9% vs 83\.3%/);
  });

  it("analyze consent and waterfall return JSON with highlights", async () => {
    const consent = await cli(["analyze", "consent", "--last", "30d"]);
    expect(consent.code, consent.stderr).toBe(0);
    expect(JSON.parse(consent.stdout).restricted_request_share).toBeCloseTo(0.4);
    const wf = await cli(["analyze", "waterfall", "--group", "Banners", "-o", "json"]);
    expect(wf.code, wf.stderr).toBe(0);
    const j = JSON.parse(wf.stdout);
    expect(j.groups).toHaveLength(1);
    expect(j.highlights.map((h: { kind: string }) => h.kind)).toContain("idle");
  });

  it("analyze waterfall names the groups when --group matches none", async () => {
    const r = await cli(["analyze", "waterfall", "--group", "Nope"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/Banners, Interstitials/);
  });

  it("lists ad sources and an ad source's adapters with their settings", async () => {
    const sources = await cli(["ad-sources", "list", "-o", "csv"]);
    expect(sources.stdout.split("\n")[1]).toBe("AdMob Network,1000000000000000000");
    const adapters = await cli(["ad-sources", "adapters", "Example Bidder"], { isTTY: true });
    expect(adapters.code, adapters.stderr).toBe(0);
    expect(adapters.stdout).toMatch(/Example Bidder \(iOS\)\s+2000000001\s+IOS\s+BANNER, INTERSTITIAL\s+Placement ID\*, Reporting key/);
  });

  it("lists mediation groups and shows one group's lines", async () => {
    const list = await cli(["mediation-groups", "list"], { isTTY: true });
    expect(list.code, list.stderr).toBe(0);
    expect(list.stdout).toMatch(/Interstitials\s+1000000002\s+ENABLED\s+IOS\s+INTERSTITIAL\s+1\s+2\s+running/);
    const show = await cli(["mediation-groups", "show", "banners"], { isTTY: true });
    expect(show.code, show.stderr).toBe(0);
    expect(show.stdout).toMatch(/Waterfall 3\.00\s+Example Waterfall\s+MANUAL\s+3\.00/);
    expect(show.stdout).toMatch(/Regions: NO, SE/);
  });

  it("lists an ad unit's mappings", async () => {
    const r = await cli(["ad-units", "mappings", "Quiz banner", "-o", "json"]);
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)[0].settings).toEqual({ "3000000001": "placement-quiz-banner" });
  });

  it("runs a campaign report", async () => {
    const r = await cli(["report", "campaign", "--from", "2026-09", "--by", "campaign", "-o", "csv"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.split("\n")[0]).toBe("Campaign name,Impressions,Clicks,CTR,Installs,Cost,CPI");
    expect(r.stdout.split("\n")[1]).toBe("Quiz cross-promo,50000,500,1.0%,40,80.00,2.00");
  });
});
