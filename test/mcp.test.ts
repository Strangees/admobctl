import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createMcpServer, MAX_TEXT_CHARS } from "../src/mcp/server.js";
import { AdmobctlError } from "../src/core/errors.js";
import { AdmobService } from "../src/core/service.js";
import type { TokenProvider } from "../src/core/auth/types.js";
import { fakeFetch, fixture, jsonResponse, noSleep } from "./helpers.js";

const token: TokenProvider = { mode: "adc", getToken: async () => "t", quotaProject: () => "qp" };

function bigReport(n: number) {
  return [
    { header: { localizationSettings: { currencyCode: "NOK" }, reportingTimeZone: "Europe/Oslo" } },
    ...Array.from({ length: n }, (_, i) => ({
      row: {
        dimensionValues: { COUNTRY: { value: `C${i}` } },
        metricValues: { ESTIMATED_EARNINGS: { microsValue: String(1_000_000 + i) }, IMPRESSIONS: { integerValue: "10" } },
      },
    })),
    { footer: { matchingRowCount: String(n) } },
  ];
}

async function connect(routes: Parameters<typeof fakeFetch>[0] = {}, opts: { serviceTtlMs?: number; now?: () => number } = {}) {
  const f = fakeFetch({
    "GET /v1/accounts?": () => jsonResponse(fixture("accounts.json")),
    "GET /apps": (c) => jsonResponse(fixture(c.url.includes("pageToken=page2") ? "apps-page2.json" : "apps-page1.json")),
    "GET /adUnits": () => jsonResponse(fixture("ad-units.json")),
    "POST /networkReport:generate": (c) => {
      const spec = (c.body as { reportSpec: { dimensions: string[]; maxReportRows?: number } }).reportSpec;
      if (spec.dimensions.includes("COUNTRY")) {
        const all = bigReport(5000);
        // The API honours maxReportRows but still reports the full matching count.
        const rows = all.slice(1, 1 + (spec.maxReportRows ?? 5000));
        return jsonResponse([all[0], ...rows, all[all.length - 1]]);
      }
      return jsonResponse(fixture("network-report-by-app.json"));
    },
    ...routes,
  });
  const dir = mkdtempSync(join(tmpdir(), "admobctl-mcp-"));
  const created: Array<string | undefined> = [];
  const server = createMcpServer({
    service: (o) => {
      created.push(o.account);
      return AdmobService.create(o, { configDir: dir, tokenProvider: token, fetch: f.fetch, sleep: noSleep, now: () => new Date("2026-10-02T08:00:00Z") });
    },
    ...opts,
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
  return { client, calls: f.calls, created };
}

type ToolResult = { isError?: boolean; content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown> };

describe("mcp server", () => {
  it("exposes the PRD tool set, all read-only with JSON-schema inputs", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "admobctl_analyze_consent",
        "admobctl_analyze_versions",
        "admobctl_analyze_waterfall",
        "admobctl_campaign_report",
        "admobctl_list_ad_sources",
        "admobctl_list_ad_unit_mappings",
        "admobctl_list_adapters",
        "admobctl_list_mediation_groups",
        "admobctl_finance_month",
        "admobctl_finance_range",
        "admobctl_insights",
        "admobctl_list_accounts",
        "admobctl_list_ad_units",
        "admobctl_list_apps",
        "admobctl_mediation_report",
        "admobctl_network_report",
      ].sort(),
    );
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint, t.name).toBe(true);
      expect(t.annotations?.openWorldHint, t.name).toBe(true);
      expect(t.inputSchema.type).toBe("object");
      expect(t.outputSchema?.type, t.name).toBe("object");
      expect(t.description!.length).toBeGreaterThan(20);
    }
    const report = tools.find((t) => t.name === "admobctl_network_report")!;
    expect(report.inputSchema.required).toEqual(["from"]);
  });

  it("returns structured content and a JSON text mirror", async () => {
    const { client } = await connect();
    const r = (await client.callTool({ name: "admobctl_list_apps", arguments: {} })) as ToolResult;
    expect(r.isError).toBeFalsy();
    const apps = r.structuredContent!.apps as Array<{ alias: string }>;
    expect(apps.map((a) => a.alias)).toContain("example-quiz-ios");
    expect(JSON.parse(r.content[0]!.text)).toEqual(r.structuredContent);
  });

  it("caps report rows by default and says so", async () => {
    const { client, calls } = await connect();
    const r = (await client.callTool({
      name: "admobctl_network_report",
      arguments: { from: "2026-09", by: ["country"] },
    })) as ToolResult;
    const sent = calls.find((c) => c.url.includes("networkReport"))!.body as { reportSpec: { maxReportRows: number } };
    expect(sent.reportSpec.maxReportRows).toBe(200);
    expect(r.structuredContent!.truncated).toBe(true);
    expect((r.structuredContent!.rows as unknown[]).length).toBe(200);
    expect(String(r.structuredContent!.notice)).toMatch(/200 of 5000/);
  });

  it("says more rows may exist when the API omits matchingRowCount", async () => {
    const { client } = await connect({
      "POST /networkReport:generate": (c) => {
        const spec = (c.body as { reportSpec: { maxReportRows?: number } }).reportSpec;
        const all = bigReport(5000);
        return jsonResponse([all[0], ...all.slice(1, 1 + (spec.maxReportRows ?? 5000))]);
      },
    });
    const r = (await client.callTool({
      name: "admobctl_network_report",
      arguments: { from: "2026-09", by: ["country"] },
    })) as ToolResult;
    expect(r.structuredContent!.truncated).toBe(true);
    expect(r.structuredContent!.totals).toBeUndefined();
    expect(String(r.structuredContent!.notice)).toMatch(/showing 200 rows; more may exist/);
    expect(String(r.structuredContent!.notice)).not.toMatch(/of \?/);
  });

  it("trims rows further to stay within the context budget", async () => {
    const { client } = await connect();
    const r = (await client.callTool({
      name: "admobctl_network_report",
      arguments: { from: "2026-09", by: ["country"], max_rows: 5000 },
    })) as ToolResult;
    expect(r.content[0]!.text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
    expect(r.structuredContent!.truncated).toBe(true);
    expect(String(r.structuredContent!.notice)).toMatch(/context/);
  });

  it("labels finance results as estimates", async () => {
    const { client } = await connect();
    const r = (await client.callTool({ name: "admobctl_finance_month", arguments: { month: "2026-09", include_journal: true } })) as ToolResult;
    expect(r.structuredContent!.total).toBe(102.45);
    expect(r.structuredContent!.estimate).toBe(true);
    expect((r.structuredContent!.journal as unknown[]).length).toBe(4);
    // A ready-to-paste block so agents never re-type tab characters.
    const tsv = String(r.structuredContent!.journal_tsv).split("\n");
    expect(tsv[0]).toBe("Bilag\tDato\tKilde\tBeskrivelse\tKonto\tKontonavn\tDebet\tKredit\tMVA-behandling\tMotpart\tStatus\tMerknad");
    expect(tsv.filter(Boolean)).toHaveLength(5);
    expect(tsv[1]!.split("\t")).toHaveLength(12);
    expect(JSON.stringify(r.structuredContent!.notes)).toMatch(/finalized/);
  });

  it("returns actionable errors as tool errors, not protocol errors", async () => {
    const { client } = await connect({
      "GET /v1/accounts?": () =>
        jsonResponse({ error: { code: 403, message: "Request had insufficient authentication scopes.", status: "PERMISSION_DENIED" } }, 403),
    });
    const r = (await client.callTool({ name: "admobctl_list_accounts", arguments: {} })) as ToolResult;
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/AdMob scope/);
    expect(r.content[0]!.text).toMatch(/Fix: gcloud auth application-default login/);
  });

  it("reuses one service across tool calls, so the account and apps are fetched once", async () => {
    const { client, calls, created } = await connect();
    for (let i = 0; i < 2; i++) {
      const r = (await client.callTool({ name: "admobctl_list_apps", arguments: {} })) as ToolResult;
      expect(r.isError).toBeFalsy();
    }
    expect(created).toHaveLength(1);
    expect(calls.filter((c) => c.url.includes("/v1/accounts?"))).toHaveLength(1);
    expect(calls.filter((c) => c.url.includes("/apps") && !c.url.includes("pageToken"))).toHaveLength(1);
  });

  it("creates a fresh service once the cached one is older than the TTL", async () => {
    let t = 0;
    const { client, created } = await connect({}, { serviceTtlMs: 1000, now: () => t });
    await client.callTool({ name: "admobctl_list_apps", arguments: {} });
    t = 999;
    await client.callTool({ name: "admobctl_list_apps", arguments: {} });
    expect(created).toHaveLength(1);
    t = 1001;
    await client.callTool({ name: "admobctl_list_apps", arguments: {} });
    expect(created).toHaveLength(2);
  });

  it("keeps a separate service per account argument", async () => {
    const { client, created } = await connect();
    await client.callTool({ name: "admobctl_list_apps", arguments: { account: "pub-0000000000000001" } });
    await client.callTool({ name: "admobctl_list_apps", arguments: { account: "pub-0000000000000001" } });
    await client.callTool({ name: "admobctl_list_apps", arguments: { account: "pub-0000000000000002" } });
    await client.callTool({ name: "admobctl_list_apps", arguments: {} });
    expect(created).toEqual(["pub-0000000000000001", "pub-0000000000000002", undefined]);
  });

  it("does not cache a service whose creation threw", async () => {
    let fail = true;
    const dir = mkdtempSync(join(tmpdir(), "admobctl-mcp-"));
    const f = fakeFetch({
      "GET /v1/accounts?": () => jsonResponse(fixture("accounts.json")),
      "GET /apps": (c) => jsonResponse(fixture(c.url.includes("pageToken=page2") ? "apps-page2.json" : "apps-page1.json")),
    });
    let created = 0;
    const server = createMcpServer({
      service: (o) => {
        created++;
        if (fail) throw new AdmobctlError("CONFIG", "config unreadable");
        return AdmobService.create(o, { configDir: dir, tokenProvider: token, fetch: f.fetch, sleep: noSleep });
      },
    });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientT);
    const first = (await client.callTool({ name: "admobctl_list_apps", arguments: {} })) as ToolResult;
    expect(first.isError).toBe(true);
    fail = false;
    const second = (await client.callTool({ name: "admobctl_list_apps", arguments: {} })) as ToolResult;
    expect(second.isError).toBeFalsy();
    expect(created).toBe(2);
  });

  it("validates inputs with readable messages", async () => {
    const { client } = await connect();
    const r = (await client.callTool({ name: "admobctl_finance_month", arguments: { month: "Sept" } })) as ToolResult;
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/YYYY-MM/);
  });

  it("passes currency through to the report and returns admobctl notices", async () => {
    const { client, calls } = await connect();
    const r = (await client.callTool({
      name: "admobctl_network_report",
      arguments: { from: "2026-10-01", to: "2026-10-02", currency: "USD" },
    })) as ToolResult;
    expect(r.isError, r.content[0]!.text).toBeFalsy();
    const sent = calls.find((c) => c.url.includes("networkReport"))!.body as { reportSpec: { localizationSettings: unknown } };
    expect(sent.reportSpec.localizationSettings).toEqual({ currencyCode: "USD" });
    expect(String(r.structuredContent!.notices)).toMatch(/Includes today/);
  });

  it("serves the curated analyses", async () => {
    const { client } = await connect({
      "POST /networkReport:generate": (c) => {
        const dims = (c.body as { reportSpec: { dimensions: string[] } }).reportSpec.dimensions;
        return jsonResponse(fixture(dims.includes("SERVING_RESTRICTION") ? "network-report-by-serving-restriction.json" : "network-report-by-sdk-version.json"));
      },
      "POST /mediationReport:generate": () => jsonResponse(fixture("mediation-report-waterfall.json")),
    });
    const versions = (await client.callTool({ name: "admobctl_analyze_versions", arguments: { by: "sdk" } })) as ToolResult;
    expect(versions.isError, versions.content[0]!.text).toBeFalsy();
    expect((versions.structuredContent!.highlights as Array<{ kind: string }>)[0]!.kind).toBe("low-show-rate");
    const consent = (await client.callTool({ name: "admobctl_analyze_consent", arguments: { last_days: 30 } })) as ToolResult;
    expect(consent.structuredContent!.estimate).toBe(true);
    const wf = (await client.callTool({ name: "admobctl_analyze_waterfall", arguments: { group: "Interstitials" } })) as ToolResult;
    expect((wf.structuredContent!.rows as unknown[]).length).toBe(1);
  });

  it("serves the v1beta reads and reports allowlisting problems as tool errors", async () => {
    const { client } = await connect({
      "GET /v1beta/accounts/pub-0000000000000001/adSources?": () => jsonResponse(fixture("ad-sources.json")),
      "GET /adSources/1000000000000000001/adapters": () => jsonResponse(fixture("adapters.json")),
      "GET /v1beta/accounts/pub-0000000000000001/mediationGroups": () =>
        jsonResponse({ error: { code: 403, message: "The caller does not have permission", status: "PERMISSION_DENIED" } }, 403),
      "POST /campaignReport:generate": () => jsonResponse(fixture("campaign-report.json")),
    });
    const sources = (await client.callTool({ name: "admobctl_list_ad_sources", arguments: {} })) as ToolResult;
    expect((sources.structuredContent!.adSources as unknown[]).length).toBe(3);
    const adapters = (await client.callTool({ name: "admobctl_list_adapters", arguments: { ad_source: "Example Bidder" } })) as ToolResult;
    expect((adapters.structuredContent!.adapters as unknown[]).length).toBe(2);
    const groups = (await client.callTool({ name: "admobctl_list_mediation_groups", arguments: {} })) as ToolResult;
    expect(groups.isError).toBe(true);
    expect(groups.content[0]!.text).toMatch(/v1beta[\s\S]*Fix: .*account manager/);
    const campaign = (await client.callTool({ name: "admobctl_campaign_report", arguments: { from: "2026-09", by: ["campaign"] } })) as ToolResult;
    expect(campaign.isError, campaign.content[0]!.text).toBeFalsy();
    expect(campaign.structuredContent!.kind).toBe("campaign");
  });
});
