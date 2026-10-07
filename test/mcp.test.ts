import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createMcpServer, MAX_TEXT_CHARS } from "../src/mcp/server.js";
import { saveConfig } from "../src/core/config.js";
import { AdmobctlError } from "../src/core/errors.js";
import { BALANCE_NOTE } from "../src/core/payments.js";
import { AdmobService } from "../src/core/service.js";
import type { TokenProvider } from "../src/core/auth/types.js";
import { fakeFetch, fixture, jsonResponse, noSleep, synthReport } from "./helpers.js";

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

/** `n` synthetic ad units of one app, more than fit the context budget when n is in the hundreds. */
function manyAdUnits(n: number) {
  return {
    adUnits: Array.from({ length: n }, (_, i) => ({
      name: `accounts/pub-0000000000000001/adUnits/${8000000000 + i}`,
      adUnitId: `ca-app-pub-0000000000000001/${8000000000 + i}`,
      appId: "ca-app-pub-0000000000000001~1111111111",
      displayName: `Example unit ${i}`,
      adFormat: "BANNER",
      adTypes: ["RICH_MEDIA"],
    })),
  };
}

/** `n` copies of the first fixture mediation group, each with its own ID. */
function manyMediationGroups(n: number) {
  const [group] = fixture<{ mediationGroups: Array<Record<string, unknown>> }>("mediation-groups.json").mediationGroups;
  return {
    mediationGroups: Array.from({ length: n }, (_, i) => ({
      ...group,
      name: `accounts/pub-0000000000000001/mediationGroups/${2000000000 + i}`,
      mediationGroupId: String(2000000000 + i),
      displayName: `Example group ${i}`,
    })),
  };
}

async function connect(
  routes: Parameters<typeof fakeFetch>[0] = {},
  opts: { serviceTtlMs?: number; now?: () => number; profile?: string; defaultProfile?: () => string | undefined } = {},
) {
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
      return AdmobService.create(
        { ...o, profile: opts.profile },
        { configDir: dir, tokenProvider: token, fetch: f.fetch, sleep: noSleep, now: () => new Date("2026-10-02T08:00:00Z") },
      );
    },
    ...opts,
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
  return { client, calls: f.calls, created, dir };
}

type ToolResult = { isError?: boolean; content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown> };

describe("mcp server", () => {
  it("exposes the PRD tool set, all read-only with JSON-schema inputs", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "admobctl_analyze_consent",
        "admobctl_analyze_geo",
        "admobctl_analyze_trend",
        "admobctl_analyze_versions",
        "admobctl_analyze_waterfall",
        "admobctl_campaign_report",
        "admobctl_check",
        "admobctl_check_app_ads",
        "admobctl_list_ad_sources",
        "admobctl_list_ad_unit_mappings",
        "admobctl_list_adapters",
        "admobctl_list_mediation_groups",
        "admobctl_finance_balance",
        "admobctl_finance_export",
        "admobctl_finance_forecast",
        "admobctl_finance_month",
        "admobctl_finance_range",
        "admobctl_insights",
        "admobctl_lint",
        "admobctl_list_accounts",
        "admobctl_list_ad_units",
        "admobctl_list_apps",
        "admobctl_mediation_report",
        "admobctl_network_report",
        "admobctl_setup_status",
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

  it("checks app-ads.txt through the same core as the CLI", async () => {
    const { client } = await connect({
      "GET itunes.apple.com/lookup": () => jsonResponse(fixture("itunes-lookup.json")),
      "GET example.com/app-ads.txt": () => new Response("google.com, pub-0000000000000001, DIRECT, f08c47fec0942fa0", { headers: { "content-type": "text/plain" } }),
    });
    const r = (await client.callTool({ name: "admobctl_check_app_ads", arguments: { app: "example-quiz-android", website: "example.com" } })) as ToolResult;
    expect(r.isError).toBeFalsy();
    const sc = r.structuredContent as { problems: number; apps: Array<{ status: string; websiteSource: string }> };
    expect(sc.problems).toBe(0);
    expect(sc.apps).toEqual([expect.objectContaining({ status: "ok", websiteSource: "flag" })]);
  });

  it("reports setup checks with fix_command and next_command", async () => {
    const { client } = await connect({
      "POST /tokeninfo": () => jsonResponse({ scope: "https://www.googleapis.com/auth/admob.readonly https://www.googleapis.com/auth/cloud-platform" }),
      "GET serviceusage.googleapis.com/v1/projects/": () => jsonResponse({ state: "DISABLED" }),
      "GET /adSources": () => jsonResponse(fixture("ad-sources.json")),
      "GET /mediationGroups": () => jsonResponse(fixture("mediation-groups.json")),
    });
    const r = (await client.callTool({ name: "admobctl_setup_status", arguments: {} })) as ToolResult;
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ ok: false, next_command: "admobctl setup apis --yes" });
  });

  const setupRoutes = {
    "POST /tokeninfo": () => jsonResponse({ scope: "https://www.googleapis.com/auth/admob.readonly https://www.googleapis.com/auth/cloud-platform" }),
    "GET serviceusage.googleapis.com/v1/projects/": () => jsonResponse({ state: "DISABLED" }),
    "GET /adSources": () => jsonResponse(fixture("ad-sources.json")),
    "GET /mediationGroups": () => jsonResponse(fixture("mediation-groups.json")),
  };
  const quotaCheck = (r: ToolResult) => (r.structuredContent!.checks as Array<{ id: string; summary: string }>).find((c) => c.id === "quota-project");

  it("admobctl_setup_status sees setup changed in a terminal since the previous call", async () => {
    const { client, dir } = await connect(setupRoutes);
    const before = (await client.callTool({ name: "admobctl_setup_status", arguments: {} })) as ToolResult;
    expect(quotaCheck(before)).toMatchObject({ summary: "Quota project: qp" });
    // The user runs `admobctl setup project use example-a --yes` in a terminal.
    saveConfig(dir, { profiles: { default: { quotaProject: "example-a" } } });
    const after = (await client.callTool({ name: "admobctl_setup_status", arguments: {} })) as ToolResult;
    expect(quotaCheck(after)).toMatchObject({ summary: "Quota project: example-a" });
  });

  it("tools after admobctl_setup_status reuse its fresh service", async () => {
    const { client, dir, calls, created } = await connect(setupRoutes);
    await client.callTool({ name: "admobctl_list_apps", arguments: {} });
    saveConfig(dir, { profiles: { default: { quotaProject: "example-a" } } });
    await client.callTool({ name: "admobctl_setup_status", arguments: {} });
    calls.length = 0;
    await client.callTool({ name: "admobctl_network_report", arguments: { from: "2026-09", by: ["app"] } });
    expect(created).toHaveLength(2);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.headers["x-goog-user-project"] === "example-a")).toBe(true);
  });

  it("returns the unpaid balance from admobctl_finance_balance", async () => {
    const { client } = await connect({ "GET /v2/accounts/": () => jsonResponse(fixture("adsense-payments.json")) });
    const r = (await client.callTool({ name: "admobctl_finance_balance", arguments: {} })) as ToolResult;
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ account: "pub-0000000000000001", currency: "NOK", unpaid: 1234.56 });
    expect(r.structuredContent!.notes).toContain(BALANCE_NOTE);
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
    // One row more than the cap, to tell a cut-short report from one that fits exactly.
    expect(sent.reportSpec.maxReportRows).toBe(201);
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

  it("keeps the matching row count when a cut-short report is trimmed further", async () => {
    const { client } = await connect();
    const r = (await client.callTool({
      name: "admobctl_network_report",
      arguments: { from: "2026-09", by: ["country"], max_rows: 3000 },
    })) as ToolResult;
    expect(r.content[0]!.text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
    const shown = (r.structuredContent!.rows as unknown[]).length;
    expect(shown).toBeLessThan(3000);
    const notice = String(r.structuredContent!.notice);
    expect(notice).toContain("showing 3000 of 5000 rows");
    expect(notice).toContain(`Showing ${shown} of 3000 returned rows to stay within the context limit`);
    // More rows would not fit either: only narrowing helps.
    expect(notice).not.toMatch(/max_rows/);
  });

  it("trims every list to the context budget and says so", async () => {
    const { client } = await connect({
      "GET /adUnits": () => jsonResponse(manyAdUnits(600)),
      "GET /mediationGroups": () => jsonResponse(manyMediationGroups(200)),
      "POST /networkReport:generate": () => jsonResponse(synthReport([])),
    });
    const cases: Array<[tool: string, args: Record<string, unknown>, key: string]> = [
      ["admobctl_list_ad_units", {}, "adUnits"],
      ["admobctl_list_mediation_groups", {}, "mediationGroups"],
      ["admobctl_lint", { last_days: 30 }, "findings"],
    ];
    for (const [tool, args, key] of cases) {
      const r = (await client.callTool({ name: tool, arguments: args })) as ToolResult;
      expect(r.isError, `${tool}: ${r.content[0]!.text.slice(0, 200)}`).toBeFalsy();
      expect(r.content[0]!.text.length, tool).toBeLessThanOrEqual(MAX_TEXT_CHARS);
      const items = r.structuredContent![key] as unknown[];
      expect(items.length, tool).toBeGreaterThan(0);
      expect(r.structuredContent!.truncated, tool).toBe(true);
      expect(String(r.structuredContent!.notice), tool).toMatch(new RegExp(`^Showing ${items.length} of \\d+ returned ${key} to stay within the context limit`));
    }
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

  it("exports Revenue Journal vouchers as file content", async () => {
    const { client } = await connect();
    const json = (await client.callTool({ name: "admobctl_finance_export", arguments: { month: "2026-09" } })) as ToolResult;
    expect(json.isError).toBeFalsy();
    expect(json.structuredContent!.as).toBe("revenue-journal-json");
    const doc = JSON.parse(String(json.structuredContent!.content)) as { format: string; vouchers: Array<{ lines: unknown[] }> };
    expect(doc.format).toBe("revenue-journal/1");
    expect(doc.vouchers).toHaveLength(1);
    expect(doc.vouchers[0]!.lines).toHaveLength(4);
    expect(JSON.stringify(json.structuredContent!.notes)).toMatch(/finalized/);

    const csv = (await client.callTool({ name: "admobctl_finance_export", arguments: { month: "2026-09", as: "csv" } })) as ToolResult;
    expect(csv.structuredContent!.as).toBe("revenue-journal-csv");
    expect(String(csv.structuredContent!.content).split("\n")[0]).toMatch(/^format,voucher_id,/);

    const ints = (await client.callTool({ name: "admobctl_finance_export", arguments: { month: "2026-09", integer_amounts: true, scale: 6 } })) as ToolResult;
    expect(JSON.parse(String(ints.structuredContent!.content)).amounts).toEqual({ encoding: "integer", scale: 6 });

    const bad = (await client.callTool({ name: "admobctl_finance_export", arguments: {} })) as ToolResult;
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toMatch(/month/);
  });

  it("returns actionable errors as tool errors, not protocol errors", async () => {
    const { client } = await connect({
      "GET /v1/accounts?": () =>
        jsonResponse({ error: { code: 403, message: "Request had insufficient authentication scopes.", status: "PERMISSION_DENIED" } }, 403),
    });
    const r = (await client.callTool({ name: "admobctl_list_accounts", arguments: {} })) as ToolResult;
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/AdMob scope/);
    expect(r.content[0]!.text).toMatch(/Fix: admobctl setup login --yes/);
  });

  const scopeDenied = {
    "GET /v1/accounts?": () =>
      jsonResponse({ error: { code: 403, message: "Request had insufficient authentication scopes.", status: "PERMISSION_DENIED" } }, 403),
  };

  it("pins Fix lines to the profile the server runs with (admobctl --profile work mcp)", async () => {
    const { client, dir } = await connect(scopeDenied, { profile: "work" });
    saveConfig(dir, { profiles: { work: {} } });
    const r = (await client.callTool({ name: "admobctl_list_apps", arguments: {} })) as ToolResult;
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/\nFix: admobctl --profile work setup login --yes$/);
  });

  it("pins Fix lines to the configured default profile, like the CLI", async () => {
    let configured: string | undefined = "work";
    const { client, dir } = await connect(scopeDenied, { defaultProfile: () => configured });
    saveConfig(dir, { defaultProfile: "work", profiles: { work: {}, home: {} } });
    const r = (await client.callTool({ name: "admobctl_list_apps", arguments: {} })) as ToolResult;
    expect(r.content[0]!.text).toMatch(/\nFix: admobctl --profile work setup login --yes$/);
    // The default changed while the server runs: services follow config.json, and so do the Fix lines.
    configured = "home";
    saveConfig(dir, { defaultProfile: "home", profiles: { work: {}, home: {} } });
    const after = (await client.callTool({ name: "admobctl_list_apps", arguments: {} })) as ToolResult;
    expect(after.content[0]!.text).toMatch(/\nFix: admobctl --profile home setup login --yes$/);
  });

  it("admobctl_setup_status names a non-default profile once", async () => {
    const { client, dir } = await connect(setupRoutes, { profile: "work" });
    saveConfig(dir, { profiles: { work: {} } });
    const r = (await client.callTool({ name: "admobctl_setup_status", arguments: {} })) as ToolResult;
    expect(r.structuredContent).toMatchObject({ next_command: "admobctl --profile work setup apis --yes" });
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

  it("creates a fresh service once config.json changed, e.g. a new alias", async () => {
    const { client, dir, created } = await connect();
    const before = (await client.callTool({ name: "admobctl_list_ad_units", arguments: { app: "mygame" } })) as ToolResult;
    expect(before.content[0]!.text).toMatch(/Unknown app "mygame"/);
    // The user runs `admobctl config set aliases.mygame <app ID>` in a terminal.
    saveConfig(dir, { profiles: { default: { aliases: { mygame: "ca-app-pub-0000000000000001~1111111111" } } } });
    const after = (await client.callTool({ name: "admobctl_list_ad_units", arguments: { app: "mygame" } })) as ToolResult;
    expect(after.isError, after.content[0]!.text).toBeFalsy();
    expect((after.structuredContent!.adUnits as Array<{ app: string }>).map((u) => u.app)).toEqual(["mygame", "mygame"]);
    expect(created).toHaveLength(2);
    // An unchanged config keeps the cached service.
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

  it("passes sort and compare through to the report", async () => {
    const { client, calls } = await connect();
    const r = (await client.callTool({
      name: "admobctl_network_report",
      arguments: { from: "2026-09", by: ["app"], sort: "impressions:asc", compare: "previous" },
    })) as ToolResult;
    expect(r.isError, r.content[0]!.text).toBeFalsy();
    const sent = calls.filter((c) => c.url.includes("networkReport")).map((c) => (c.body as { reportSpec: { sortConditions: unknown } }).reportSpec);
    expect(sent).toHaveLength(2);
    expect(sent[0]!.sortConditions).toEqual([{ metric: "IMPRESSIONS", order: "ASCENDING" }]);
    expect(r.structuredContent!.previous).toMatchObject({ from: "2026-08-02", to: "2026-08-31" });
    expect((r.structuredContent!.rows as Array<Record<string, unknown>>)[0]).toHaveProperty("previous_earnings");
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
    expect((consent.structuredContent!.apps as Array<{ app: string }>)[0]!.app).toBe("example-quiz-ios");
    const wf = (await client.callTool({ name: "admobctl_analyze_waterfall", arguments: { group: "Interstitials" } })) as ToolResult;
    expect((wf.structuredContent!.rows as unknown[]).length).toBe(1);
  });

  it("says when the geo country totals are cut to the biggest", async () => {
    const country = (c: string) => ({
      row: { dimensionValues: { COUNTRY: { value: c }, FORMAT: { value: "BANNER" } }, metricValues: { ESTIMATED_EARNINGS: { microsValue: "1000000" }, AD_REQUESTS: { integerValue: "10" } } },
    });
    const codes = Array.from({ length: 30 }, (_, i) => `C${i}`);
    const { client } = await connect({
      "POST /networkReport:generate": () => jsonResponse([{ header: { localizationSettings: { currencyCode: "NOK" } } }, ...codes.map(country)]),
    });
    const r = (await client.callTool({ name: "admobctl_analyze_geo", arguments: { last_days: 7 } })) as ToolResult;
    expect(r.isError, r.content[0]!.text).toBeFalsy();
    expect(r.structuredContent!.countries).toHaveLength(25);
    expect(r.structuredContent!.notices).toContain("`countries` lists the 25 biggest of 30 countries; the rows cover all of them.");
  });

  it("serves the daily trend without the day rows unless asked", async () => {
    const day = (n: number) => ({
      row: { dimensionValues: { DATE: { value: `202609${String(n).padStart(2, "0")}` } }, metricValues: { ESTIMATED_EARNINGS: { microsValue: "1000000" }, AD_REQUESTS: { integerValue: "10" } } },
    });
    const { client } = await connect({
      "POST /networkReport:generate": () => jsonResponse([{ header: { localizationSettings: { currencyCode: "NOK" } } }, day(28), day(29), day(30)]),
    });
    const plain = (await client.callTool({ name: "admobctl_analyze_trend", arguments: { last_days: 7 } })) as ToolResult;
    expect(plain.isError, plain.content[0]!.text).toBeFalsy();
    const series = (plain.structuredContent!.rows as Array<Record<string, unknown>>)[0]!;
    expect(series).toMatchObject({ label: "All apps", earnings: 3, first_active: "2026-09-28" });
    expect(series.days).toBeUndefined();
    const withDays = (await client.callTool({ name: "admobctl_analyze_trend", arguments: { last_days: 7, include_days: true } })) as ToolResult;
    expect(((withDays.structuredContent!.rows as Array<{ days: unknown[] }>)[0]!.days).length).toBe(4);
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
