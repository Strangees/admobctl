import { describe, expect, it } from "vitest";
import { AdmobClient } from "../src/core/client.js";
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
