/**
 * Regenerates evals/mocks/admobctl/*.md (canned MCP tool results for `claude plugin eval`)
 * by running the real tools against synthetic fixtures. Skipped unless GEN_MOCKS=1:
 *   npm run eval:mocks
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { it } from "vitest";
import { AdmobService } from "../src/core/service.js";
import { createMcpServer } from "../src/mcp/server.js";
import { fakeFetch, fixture, jsonResponse, noSleep, type RecordedCall } from "./helpers.js";

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

it.skipIf(!process.env.GEN_MOCKS)("generate eval mocks", async () => {
  const f = fakeFetch({
    "GET /v1/accounts?": () => jsonResponse(fixture("accounts.json")),
    "GET /apps": (c) => jsonResponse(fixture(c.url.includes("pageToken=page2") ? "apps-page2.json" : "apps-page1.json")),
    "GET /adUnits": () => jsonResponse(fixture("ad-units.json")),
    "POST /networkReport:generate": (c: RecordedCall) => {
      const spec = (c.body as { reportSpec: { dimensions: string[]; dateRange: { startDate: { month: number } } } }).reportSpec;
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
  const server = createMcpServer({
    service: (o) =>
      AdmobService.create(o, {
        configDir: dir,
        fetch: f.fetch,
        sleep: noSleep,
        tokenProvider: { mode: "adc", getToken: async () => "t", quotaProject: () => "q" },
        now: () => new Date("2026-10-02T08:00:00Z"),
      }),
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "gen-eval-mocks", version: "0" });
  await client.connect(clientT);
  const calls: Record<string, Record<string, unknown>> = {
    admobctl_list_accounts: {},
    admobctl_list_apps: {},
    admobctl_list_ad_units: {},
    admobctl_network_report: { from: "2026-09", by: ["app"] },
    admobctl_mediation_report: { from: "2026-09", by: ["app"] },
    admobctl_finance_month: { month: "2026-09", include_journal: true },
    admobctl_finance_range: { from: "2026-07", to: "2026-09" },
    admobctl_finance_export: { month: "2026-09" },
    admobctl_finance_forecast: {},
    admobctl_insights: { last_days: 30, by: "ad-unit" },
    admobctl_check: {},
    admobctl_lint: {},
    admobctl_analyze_versions: { by: "sdk", last_days: 30 },
    admobctl_analyze_consent: { last_days: 30 },
    admobctl_analyze_waterfall: { last_days: 30 },
    admobctl_analyze_trend: { last_days: 30 },
    admobctl_campaign_report: { from: "2026-09", by: ["campaign"] },
    admobctl_list_ad_sources: {},
    admobctl_list_adapters: { ad_source: "Example Bidder" },
    admobctl_list_mediation_groups: {},
    admobctl_list_ad_unit_mappings: { ad_unit: "Quiz banner" },
  };
  for (const [name, args] of Object.entries(calls)) {
    const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> };
    writeFileSync(new URL(`../evals/mocks/admobctl/${name}.md`, import.meta.url), `${r.content[0]!.text}\n`);
  }
});
