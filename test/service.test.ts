import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { saveConfig } from "../src/core/config.js";
import { AdmobService } from "../src/core/service.js";
import type { TokenProvider } from "../src/core/auth/types.js";
import { fakeFetch, fixture, jsonResponse, noSleep } from "./helpers.js";

const token: TokenProvider = { mode: "adc", getToken: async () => "t", quotaProject: () => "adc-quota" };

const baseRoutes = {
  "GET /v1/accounts?": () => jsonResponse(fixture("accounts.json")),
  "GET /apps": (c: { url: string }) =>
    jsonResponse(fixture(c.url.includes("pageToken=page2") ? "apps-page2.json" : "apps-page1.json")),
  "GET /adUnits": () => jsonResponse(fixture("ad-units.json")),
  "POST /networkReport:generate": () => jsonResponse(fixture("network-report-by-app.json")),
};

function service(opts: { profile?: Record<string, unknown>; account?: string; routes?: Parameters<typeof fakeFetch>[0] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "admobctl-svc-"));
  if (opts.profile) saveConfig(dir, { profiles: { default: opts.profile } });
  const f = fakeFetch({ ...baseRoutes, ...opts.routes });
  const svc = AdmobService.create(
    { account: opts.account },
    { configDir: dir, tokenProvider: token, fetch: f.fetch, sleep: noSleep, now: () => new Date("2026-10-02T08:00:00Z") },
  );
  return { svc, calls: f.calls };
}

describe("AdmobService", () => {
  it("auto-selects the only account and uses the ADC quota project", async () => {
    const { svc, calls } = service();
    const acct = await svc.account();
    expect(acct.publisherId).toBe("pub-0000000000000001");
    expect(calls[0]!.headers["x-goog-user-project"]).toBe("adc-quota");
  });

  it("prefers the configured quota project over the ADC one", async () => {
    const { svc, calls } = service({ profile: { quotaProject: "cfg-quota" } });
    await svc.account();
    expect(calls[0]!.headers["x-goog-user-project"]).toBe("cfg-quota");
  });

  it("errors clearly when the requested account is not accessible", async () => {
    const { svc } = service({ account: "pub-999" });
    await expect(svc.account()).rejects.toThrow(/pub-999.*pub-0000000000000001/);
  });

  it("retries accounts.list after a failure instead of caching the rejection", async () => {
    let n = 0;
    const { svc, calls } = service({
      routes: {
        "GET /v1/accounts?": () =>
          ++n === 1
            ? jsonResponse({ error: { code: 403, message: "Request had insufficient authentication scopes.", status: "PERMISSION_DENIED" } }, 403)
            : jsonResponse(fixture("accounts.json")),
      },
    });
    await expect(svc.account()).rejects.toThrow();
    await expect(svc.apps()).resolves.toHaveLength(3);
    expect((await svc.account()).publisherId).toBe("pub-0000000000000001");
    expect(calls.filter((c) => c.url.includes("/v1/accounts?"))).toHaveLength(2);
  });

  it("retries apps.list after a failure instead of caching the rejection", async () => {
    let n = 0;
    const { svc } = service({
      routes: {
        "GET /apps": (c) =>
          ++n === 1
            ? jsonResponse({ error: { code: 403, message: "The caller does not have permission", status: "PERMISSION_DENIED" } }, 403)
            : jsonResponse(fixture(c.url.includes("pageToken=page2") ? "apps-page2.json" : "apps-page1.json")),
      },
    });
    await expect(svc.apps()).rejects.toThrow();
    await expect(svc.apps()).resolves.toHaveLength(3);
  });

  it("lists apps with aliases", async () => {
    const { svc } = service({ profile: { aliases: { timer: "ca-app-pub-0000000000000001~3333333333" } } });
    const apps = await svc.apps();
    expect(apps.map((a) => a.alias)).toEqual(["example-quiz-ios", "example-quiz-android", "timer"]);
  });

  it("filters ad units by app alias and labels them with the alias", async () => {
    const { svc } = service();
    const units = await svc.adUnits({ app: "example-quiz-ios" });
    expect(units.map((u) => u.name)).toEqual(["Quiz banner", "Quiz interstitial"]);
    expect(units[0]).toMatchObject({ app: "example-quiz-ios", format: "BANNER", adUnitId: "ca-app-pub-0000000000000001/9000000001" });
  });

  it("runs a network report and returns friendly rows", async () => {
    const { svc, calls } = service();
    const r = await svc.networkReport({ from: "2026-09", to: "2026-09", by: ["app"], filters: { app: ["example-quiz-ios"] } });
    const sent = calls.find((c) => c.url.includes("networkReport"))!.body as { reportSpec: { dimensionFilters: unknown } };
    // App aliases in filters are resolved to app IDs before hitting the API.
    expect(sent.reportSpec.dimensionFilters).toEqual([
      { dimension: "APP", matchesAny: { values: ["ca-app-pub-0000000000000001~1111111111"] } },
    ]);
    expect(r.currency).toBe("NOK");
    expect(r.from).toBe("2026-09-01");
    expect(r.to).toBe("2026-09-30");
    expect(r.rows[0]).toMatchObject({
      app: "example-quiz-ios",
      app_name: "Example Quiz",
      app_id: "ca-app-pub-0000000000000001~1111111111",
      earnings: 60.13,
      earnings_micros: 60_125_000,
      impressions: 12000,
      requests: 20000,
      match_rate: 0.75,
      rpm: 5.01,
    });
    expect(r.totals).toMatchObject({ earnings: 102.45, earnings_micros: 102_450_000, impressions: 23000 });
    expect(r.truncated).toBe(false);
  });

  it("lists dimensions and metrics by the keys used in rows and totals", async () => {
    const { svc } = service();
    const r = await svc.networkReport({ from: "2026-09", to: "2026-09", by: ["app"] });
    expect(r.dimensions).toEqual(["app"]);
    expect(r.metrics).toContain("earnings");
    expect(r.metrics).toContain("rpm");
    expect(r.metrics).not.toContain("estimated_earnings");
    expect(r.metrics).not.toContain("impression_rpm");
    for (const row of r.rows) {
      for (const key of [...r.dimensions, ...r.metrics]) expect(row).toHaveProperty(key);
    }
    for (const key of r.metrics) expect(r.totals).toHaveProperty(key);
  });

  it("flags truncation when the row cap cuts the report", async () => {
    const { svc } = service();
    const r = await svc.networkReport({ from: "2026-09", to: "2026-09", by: ["app"], maxRows: 2 });
    expect(r.rows).toHaveLength(2);
    expect(r.truncated).toBe(true);
  });

  it("keeps a report complete when matchingRowCount equals the row cap", async () => {
    const { svc } = service();
    const r = await svc.networkReport({ from: "2026-09", to: "2026-09", by: ["app"], maxRows: 3 });
    expect(r.rows).toHaveLength(3);
    expect(r.truncated).toBe(false);
    expect(r.matchingRowCount).toBe(3);
    expect(r.totals).toMatchObject({ earnings_micros: 102_450_000 });
  });

  describe("when the API omits matchingRowCount", () => {
    const noFooter = () =>
      jsonResponse(fixture<Array<Record<string, unknown>>>("network-report-by-app.json").filter((e) => !("footer" in e)));
    const routes = { "POST /networkReport:generate": noFooter } as unknown as Record<string, never>;

    it("treats a report that fills maxRows exactly as possibly truncated", async () => {
      const { svc } = service({ routes });
      const r = await svc.networkReport({ from: "2026-09", to: "2026-09", by: ["app"], maxRows: 3 });
      expect(r.rows).toHaveLength(3);
      expect(r.truncated).toBe(true);
      expect(r.totals).toBeUndefined();
      expect(r.matchingRowCount).toBeUndefined();
    });

    it("treats a report with fewer rows than maxRows as complete", async () => {
      const { svc } = service({ routes });
      const r = await svc.networkReport({ from: "2026-09", to: "2026-09", by: ["app"], maxRows: 5 });
      expect(r.rows).toHaveLength(3);
      expect(r.truncated).toBe(false);
      expect(r.totals).toMatchObject({ earnings_micros: 102_450_000 });
    });

    it("treats a report without a row cap as complete", async () => {
      const { svc } = service({ routes });
      const r = await svc.networkReport({ from: "2026-09", to: "2026-09", by: ["app"] });
      expect(r.truncated).toBe(false);
      expect(r.totals).toBeDefined();
    });
  });

  it("does not call a complete report truncated when matchingRowCount exceeds the rows returned", async () => {
    // Google: matchingRowCount "does NOT always match the number of rows in the response".
    const overCount = () =>
      jsonResponse(
        fixture<Array<Record<string, unknown>>>("network-report-by-app.json").map((e) => ("footer" in e ? { footer: { matchingRowCount: "5" } } : e)),
      );
    const { svc } = service({ routes: { "POST /networkReport:generate": overCount } });
    const r = await svc.networkReport({ from: "2026-09", to: "2026-09", by: ["app"] });
    expect(r.truncated).toBe(false);
    expect(r.totals).toMatchObject({ earnings_micros: 102_450_000 });
    expect(r.matchingRowCount).toBe(5);
  });

  it("sends --currency to the API and reports the currency it answered in", async () => {
    const { svc, calls } = service({
      routes: {
        "POST /networkReport:generate": () =>
          jsonResponse(
            fixture<Array<Record<string, { localizationSettings?: unknown }>>>("network-report-by-app.json").map((e) =>
              e.header ? { header: { ...e.header, localizationSettings: { currencyCode: "USD" } } } : e,
            ),
          ),
      },
    });
    const r = await svc.networkReport({ from: "2026-09", by: ["app"], currency: "USD" });
    const sent = calls.find((c) => c.url.includes("networkReport"))!.body as { reportSpec: { localizationSettings: unknown } };
    expect(sent.reportSpec.localizationSettings).toEqual({ currencyCode: "USD" });
    expect(r.currency).toBe("USD");
  });

  it("leaves out default metrics the dimensions cannot be combined with, and says so", async () => {
    const { svc, calls } = service();
    const r = await svc.networkReport({ from: "2026-09", by: ["ad-type"] });
    const sent = calls.find((c) => c.url.includes("networkReport"))!.body as { reportSpec: { metrics: string[] } };
    expect(sent.reportSpec.metrics).not.toContain("AD_REQUESTS");
    expect(sent.reportSpec.metrics).not.toContain("IMPRESSION_RPM");
    expect(sent.reportSpec.metrics).toContain("ESTIMATED_EARNINGS");
    expect(r.notices.join(" ")).toMatch(/Left out requests, match-rate, rpm/);
  });

  it("rejects explicitly requested metrics that ad-type cannot be combined with", async () => {
    const { svc } = service();
    await expect(svc.networkReport({ from: "2026-09", by: ["ad-type"], metrics: ["requests"] })).rejects.toThrow(/ad-type/);
  });

  it("notes that today's data is partial", async () => {
    const { svc } = service();
    const r = await svc.networkReport({ from: "2026-10-01", to: "2026-10-02", by: ["app"] });
    expect(r.notices.join(" ")).toMatch(/today.*partial/i);
    const past = await svc.networkReport({ from: "2026-09", by: ["app"] });
    expect(past.notices).toEqual([]);
  });

  it("notes that third-party ad sources lag up to a day in mediation reports", async () => {
    const { svc } = service({ routes: { "POST /mediationReport:generate": () => jsonResponse(fixture("network-report-by-app.json")) } });
    const r = await svc.mediationReport({ from: "2026-10-01", by: ["app"] });
    expect(r.notices.join(" ")).toMatch(/third-party/i);
  });

  it("caches ad units for the life of the service", async () => {
    const { svc, calls } = service();
    await svc.adUnits();
    await svc.adUnits({ app: "example-quiz-ios" });
    expect(calls.filter((c) => c.url.includes("/adUnits"))).toHaveLength(1);
  });
});
