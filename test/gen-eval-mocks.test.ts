/**
 * Regenerates plugin/evals/mocks/admobctl/*.md (canned MCP tool results for `claude plugin eval`)
 * by running the real tools against synthetic fixtures. Skipped unless GEN_MOCKS=1:
 *   npm run eval:mocks
 * The check that every MCP tool has a mock always runs.
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import { GOOGLE_CERT_ID } from "../src/core/app-ads.js";
import { AdmobService } from "../src/core/service.js";
import { createMcpServer, type McpDeps } from "../src/mcp/server.js";
import { fakeFetch, fixture, jsonResponse, noSleep, synthReport, type RecordedCall } from "./helpers.js";

const mocksDir = new URL("../plugin/evals/mocks/admobctl/", import.meta.url);

/** One mocked call per MCP tool; its result becomes plugin/evals/mocks/admobctl/<tool>.md. */
const calls: Record<string, Record<string, unknown>> = {
  admobctl_list_accounts: {},
  admobctl_list_apps: {},
  admobctl_list_ad_units: {},
  admobctl_check_app_ads: {},
  admobctl_network_report: { from: "2026-09", by: ["app"] },
  admobctl_mediation_report: { from: "2026-09", by: ["app"] },
  admobctl_finance_month: { month: "2026-09", include_journal: true },
  admobctl_finance_range: { from: "2026-07", to: "2026-09" },
  admobctl_finance_export: { month: "2026-09" },
  admobctl_finance_forecast: {},
  admobctl_finance_balance: {},
  admobctl_setup_status: {},
  admobctl_insights: { last_days: 30, by: "ad-unit" },
  admobctl_check: {},
  admobctl_lint: {},
  admobctl_analyze_versions: { by: "sdk", last_days: 30 },
  admobctl_analyze_consent: { last_days: 30 },
  admobctl_analyze_waterfall: { last_days: 30 },
  admobctl_analyze_trend: { last_days: 30 },
  admobctl_analyze_geo: { last_days: 30 },
  admobctl_campaign_report: { from: "2026-09", by: ["campaign"] },
  admobctl_list_ad_sources: {},
  admobctl_list_adapters: { ad_source: "Example Bidder" },
  admobctl_list_mediation_groups: {},
  admobctl_list_ad_unit_mappings: { ad_unit: "Quiz banner" },
};

async function connect(service: McpDeps["service"]): Promise<Client> {
  const server = createMcpServer({ service });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "gen-eval-mocks", version: "0" });
  await client.connect(clientT);
  return client;
}

type Unit = [id: string, label: string, earnings: number, requests: number, matched: number, impressions: number, clicks: number];
const unitId = (n: number) => `ca-app-pub-0000000000000001/900000000${n}`;
// Ad units match test/fixtures/api/ad-units.json so the mocked world is consistent.
const current: Unit[] = [
  [unitId(1), "Quiz banner", 60e6, 20000, 19000, 15000, 150],
  [unitId(3), "Quiz banner (Android)", 30e6, 40000, 8000, 6000, 60], // low fill
  [unitId(4), "Timer banner", 10e6, 5000, 4900, 1500, 5], // low show rate
];
const previous: Unit[] = [
  [unitId(1), "Quiz banner", 30e6, 18000, 17000, 14000, 120],
  [unitId(3), "Quiz banner (Android)", 31e6, 39000, 8100, 6100, 61],
  [unitId(4), "Timer banner", 10.5e6, 5100, 5000, 1600, 6],
];

function adUnitReport(units: Unit[]) {
  return [
    { header: { localizationSettings: { currencyCode: "NOK" }, reportingTimeZone: "Europe/Oslo" } },
    ...units.map(([value, displayLabel, e, r, m, i, c]) => ({
      row: {
        dimensionValues: { AD_UNIT: { value, displayLabel } },
        metricValues: {
          ESTIMATED_EARNINGS: { microsValue: String(e) },
          AD_REQUESTS: { integerValue: String(r) },
          MATCHED_REQUESTS: { integerValue: String(m) },
          IMPRESSIONS: { integerValue: String(i) },
          CLICKS: { integerValue: String(c) },
        },
      },
    })),
    { footer: { matchingRowCount: String(units.length) } },
  ];
}

/** 30 days ending 2026-10-01: about 3 a day, then about 2 a day from 2026-09-20. */
function dailyReport() {
  return [
    { header: { localizationSettings: { currencyCode: "NOK" }, reportingTimeZone: "Europe/Oslo" } },
    ...Array.from({ length: 30 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 8, 2 + i));
      const value = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
      const earnings = (i < 18 ? 3_000_000 : 2_000_000) + (i % 3) * 100_000;
      return {
        row: {
          dimensionValues: { DATE: { value } },
          metricValues: {
            ESTIMATED_EARNINGS: { microsValue: String(earnings) },
            AD_REQUESTS: { integerValue: "2000" },
            MATCHED_REQUESTS: { integerValue: "1500" },
            IMPRESSIONS: { integerValue: String(i < 18 ? 1200 : 800) },
          },
        },
      };
    }),
    { footer: { matchingRowCount: "30" } },
  ];
}

const geoCell = (country: string, format: string, earnings: number, requests: number, matched: number, impressions: number): Parameters<typeof synthReport>[0][number] => [
  { COUNTRY: [country], FORMAT: [format] },
  { ESTIMATED_EARNINGS: earnings, AD_REQUESTS: requests, MATCHED_REQUESTS: matched, IMPRESSIONS: impressions },
];
const geoReport = () =>
  synthReport([
    geoCell("NO", "banner", 50e6, 30000, 27000, 22000),
    geoCell("SE", "banner", 18e6, 28000, 9000, 7500), // low fill
    geoCell("NO", "interstitial", 25e6, 4000, 3600, 1800),
    geoCell("US", "banner", 9e6, 1500, 1400, 1200), // high eCPM, little traffic
    geoCell("DK", "banner", 0.4e6, 400, 380, 300),
  ]);

it.skipIf(!process.env.GEN_MOCKS)("generate eval mocks", async () => {
  const f = fakeFetch({
    "GET /v1/accounts?": () => jsonResponse(fixture("accounts.json")),
    "GET /apps": (c) => jsonResponse(fixture(c.url.includes("pageToken=page2") ? "apps-page2.json" : "apps-page1.json")),
    "GET itunes.apple.com/lookup": () => jsonResponse(fixture("itunes-lookup.json")),
    "GET https://example.com/app-ads.txt": () =>
      new Response(`google.com, pub-0000000000000001, DIRECT, ${GOOGLE_CERT_ID}\n`, { headers: { "content-type": "text/plain" } }),
    "GET /v2/accounts/": () => jsonResponse(fixture("adsense-payments.json")),
    "POST /tokeninfo": () =>
      jsonResponse({ scope: "https://www.googleapis.com/auth/admob.readonly https://www.googleapis.com/auth/cloud-platform", expires_in: "3000" }),
    "GET serviceusage.googleapis.com/v1/projects/": () => jsonResponse({ state: "ENABLED" }),
    "GET /adUnits": () => jsonResponse(fixture("ad-units.json")),
    "POST /networkReport:generate": (c: RecordedCall) => {
      const spec = (c.body as { reportSpec: { dimensions: string[]; dateRange: { startDate: { month: number } } } }).reportSpec;
      if (spec.dimensions.includes("COUNTRY")) return jsonResponse(geoReport());
      if (spec.dimensions.includes("DATE")) return jsonResponse(dailyReport());
      if (spec.dimensions.includes("AD_UNIT")) return jsonResponse(adUnitReport(spec.dateRange.startDate.month === 9 ? current : previous));
      if (spec.dimensions.includes("GMA_SDK_VERSION")) return jsonResponse(fixture("network-report-by-sdk-version.json"));
      if (spec.dimensions.includes("SERVING_RESTRICTION")) return jsonResponse(fixture("network-report-by-serving-restriction.json"));
      return jsonResponse(fixture(spec.dimensions.includes("MONTH") ? "network-report-by-month-app.json" : "network-report-by-app.json"));
    },
    "GET /v1beta/accounts/pub-0000000000000001/adSources?": () => jsonResponse(fixture("ad-sources.json")),
    "GET /adSources/1000000000000000001/adapters": () => jsonResponse(fixture("adapters.json")),
    "GET /v1beta/accounts/pub-0000000000000001/mediationGroups": () => jsonResponse(fixture("mediation-groups.json")),
    "GET /adUnits/9000000001/adUnitMappings": () => jsonResponse(fixture("ad-unit-mappings.json")),
    "POST /campaignReport:generate": () => jsonResponse(fixture("campaign-report.json")),
    "POST /mediationReport:generate": (c: RecordedCall) => {
      const dims = (c.body as { reportSpec: { dimensions: string[] } }).reportSpec.dimensions;
      return jsonResponse(fixture(dims.includes("MEDIATION_GROUP") ? "mediation-report-waterfall.json" : "network-report-by-app.json"));
    },
  });
  const dir = mkdtempSync(join(tmpdir(), "admobctl-mocks-"));
  const client = await connect((o) =>
    AdmobService.create(o, {
      configDir: dir,
      fetch: f.fetch,
      sleep: noSleep,
      tokenProvider: { mode: "adc", getToken: async () => "t", quotaProject: () => "q" },
      now: () => new Date("2026-10-02T08:00:00Z"),
    }),
  );
  // Start from an empty set, so a mock for a tool that no longer exists shows up as deleted.
  for (const file of readdirSync(mocksDir).filter((f) => f.endsWith(".md"))) rmSync(new URL(file, mocksDir));
  for (const [name, args] of Object.entries(calls)) {
    const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    if (r.isError) throw new Error(`${name}: ${r.content[0]?.text}`);
    writeFileSync(new URL(`${name}.md`, mocksDir), `${r.content[0]!.text}\n`);
  }
});

// After the generator, so with GEN_MOCKS=1 it checks the files just written.
it("has a mocked call, and a committed mock, for every MCP tool", async () => {
  const client = await connect(() => {
    throw new Error("listing tools needs no service");
  });
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  expect(Object.keys(calls).sort()).toEqual(tools);
  const committed = readdirSync(mocksDir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort();
  expect(committed).toEqual(tools);
});
