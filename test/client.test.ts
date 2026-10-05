import { describe, expect, it } from "vitest";
import { AdmobClient } from "../src/core/client.js";
import { PAYMENTS_LOGIN_COMMAND } from "../src/core/errors.js";
import { fakeFetch, fixture, jsonResponse, noSleep } from "./helpers.js";

function makeClient(routes: Parameters<typeof fakeFetch>[0], quotaProject?: string) {
  const f = fakeFetch(routes);
  const client = new AdmobClient({
    getToken: async () => "test-token",
    quotaProject,
    fetch: f.fetch,
    sleep: noSleep,
  });
  return { client, calls: f.calls };
}

describe("AdmobClient", () => {
  it("sends the bearer token and quota project header", async () => {
    const { client, calls } = makeClient({ "GET /v1/accounts": () => jsonResponse(fixture("accounts.json")) }, "my-quota");
    const accounts = await client.listAccounts();
    expect(accounts[0]!.publisherId).toBe("pub-0000000000000001");
    expect(calls[0]!.headers.authorization).toBe("Bearer test-token");
    expect(calls[0]!.headers["x-goog-user-project"]).toBe("my-quota");
  });

  it("omits the quota header when none is configured", async () => {
    const { client, calls } = makeClient({ "GET /v1/accounts": () => jsonResponse(fixture("accounts.json")) });
    await client.listAccounts();
    expect(calls[0]!.headers["x-goog-user-project"]).toBeUndefined();
  });

  it("follows pagination for apps", async () => {
    const { client, calls } = makeClient({
      "GET /apps": (c) => jsonResponse(fixture(c.url.includes("pageToken=page2") ? "apps-page2.json" : "apps-page1.json")),
    });
    const apps = await client.listApps("pub-0000000000000001");
    expect(apps).toHaveLength(3);
    expect(calls[0]!.url).toContain("/v1/accounts/pub-0000000000000001/apps");
    expect(calls).toHaveLength(2);
  });

  it("posts a network report spec and parses the streamed array", async () => {
    const { client, calls } = makeClient({
      "POST /networkReport:generate": () => jsonResponse(fixture("network-report-by-app.json")),
    });
    const spec = { dimensions: ["APP"], metrics: ["ESTIMATED_EARNINGS"] };
    const report = await client.networkReport("accounts/pub-0000000000000001", spec);
    expect(calls[0]!.url).toContain("/v1/accounts/pub-0000000000000001/networkReport:generate");
    expect(calls[0]!.body).toEqual({ reportSpec: spec });
    expect(report.rows).toHaveLength(3);
  });

  it("raises an actionable error for API failures", async () => {
    const { client } = makeClient({
      "GET /v1/accounts": () =>
        jsonResponse({ error: { code: 403, message: "Request had insufficient authentication scopes.", status: "PERMISSION_DENIED" } }, 403),
    });
    await expect(client.listAccounts()).rejects.toMatchObject({ code: "AUTH_SCOPE_MISSING" });
  });
});

describe("AdmobClient.listPayments (AdSense Management API)", () => {
  const PUB = "pub-0000000000000001";
  const scopeError = () =>
    jsonResponse(
      {
        error: {
          code: 403,
          message: "Request had insufficient authentication scopes.",
          status: "PERMISSION_DENIED",
          details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }],
        },
      },
      403,
    );

  it("GETs the account's payments from adsense.googleapis.com/v2 with auth and quota headers", async () => {
    const { client, calls } = makeClient({ "GET /v2/accounts/": () => jsonResponse(fixture("adsense-payments.json")) }, "qp");
    const payments = await client.listPayments(PUB);
    expect(calls[0]!.url).toBe(`https://adsense.googleapis.com/v2/accounts/${PUB}/payments`);
    expect(calls[0]!.headers.authorization).toBe("Bearer test-token");
    expect(calls[0]!.headers["x-goog-user-project"]).toBe("qp");
    expect(payments).toHaveLength(2);
    expect(payments[0]).toEqual({ name: `accounts/${PUB}/payments/unpaid`, amount: "NOK\u00a01,234.56" });
  });

  it("returns an empty list when the response has no payments", async () => {
    const { client } = makeClient({ "GET /v2/accounts/": () => jsonResponse({}) });
    expect(await client.listPayments(`accounts/${PUB}`)).toEqual([]);
  });

  it("explains a missing adsense scope with a login fix that keeps the write scope", async () => {
    const { client } = makeClient({ "GET /v2/accounts/": scopeError });
    const err = await client.listPayments(PUB).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "AUTH_SCOPE_MISSING" });
    const fix = (err as { fix: string }).fix;
    expect(fix).toContain(PAYMENTS_LOGIN_COMMAND);
    expect(fix).toContain("admob.monetization");
    expect(fix).toContain("admobctl auth login --payments");
    expect(fix).toMatch(/auth login --payments[^)]*--write/);
  });

  it.each([
    [403, { error: { code: 403, message: "The caller does not have permission", status: "PERMISSION_DENIED" } }],
    [404, { error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } }],
  ])("maps a %i for the account to PAYMENTS_UNAVAILABLE", async (status, body) => {
    const { client } = makeClient({ "GET /v2/accounts/": () => jsonResponse(body, status) });
    const err = await client.listPayments(PUB).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "PAYMENTS_UNAVAILABLE" });
    expect((err as Error).message).toContain(PUB);
    expect((err as Error).message).toContain(body.error.message);
    expect((err as { fix?: string }).fix).toBeTruthy();
  });

  it("tells how to enable the AdSense API, including the service-account pitfall", async () => {
    const { client } = makeClient({
      "GET /v2/accounts/": () =>
        jsonResponse(
          {
            error: {
              code: 403,
              message: "AdSense Management API has not been used in project qp before or it is disabled.",
              status: "PERMISSION_DENIED",
              details: [
                {
                  "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                  reason: "SERVICE_DISABLED",
                  metadata: { consumer: "projects/qp", service: "adsense.googleapis.com", serviceTitle: "AdSense Management API" },
                },
              ],
            },
          },
          403,
        ),
    });
    const err = await client.listPayments(PUB).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "API_NOT_ENABLED" });
    const fix = (err as { fix: string }).fix;
    expect(fix.startsWith("gcloud services enable adsense.googleapis.com --project qp")).toBe(true);
    expect(fix).toContain("--account");
    expect(fix).toContain("minute");
  });
});
