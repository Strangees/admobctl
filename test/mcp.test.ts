import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createMcpServer, MAX_TEXT_CHARS } from "../src/mcp/server.js";
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

async function connect(routes: Parameters<typeof fakeFetch>[0] = {}) {
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
  const server = createMcpServer({
    service: (opts) =>
      AdmobService.create(opts, { configDir: dir, tokenProvider: token, fetch: f.fetch, sleep: noSleep, now: () => new Date("2026-10-02T08:00:00Z") }),
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
  return { client, calls: f.calls };
}

type ToolResult = { isError?: boolean; content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown> };

describe("mcp server", () => {
  it("exposes the PRD tool set, all read-only with JSON-schema inputs", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
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

  it("validates inputs with readable messages", async () => {
    const { client } = await connect();
    const r = (await client.callTool({ name: "admobctl_finance_month", arguments: { month: "Sept" } })) as ToolResult;
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/YYYY-MM/);
  });
});
