import { describe, expect, it } from "vitest";
import { CloudClient } from "../src/core/setup/cloud.js";
import { fakeFetch, jsonResponse, noSleep } from "./helpers.js";

function client(routes: Parameters<typeof fakeFetch>[0]) {
  const f = fakeFetch(routes);
  let t = 0;
  const c = new CloudClient({ getToken: async () => "tok", fetch: f.fetch, sleep: async (ms) => void (t += ms), now: () => t });
  return { c, calls: f.calls };
}

describe("CloudClient", () => {
  it("lists active projects across pages, without a quota header", async () => {
    const { c, calls } = client({
      "GET /v3/projects:search": (call) =>
        call.url.includes("pageToken=p2")
          ? jsonResponse({ projects: [{ projectId: "example-b", displayName: "B", state: "ACTIVE" }] })
          : jsonResponse({
              projects: [
                { projectId: "example-a", displayName: "A", state: "ACTIVE" },
                { projectId: "example-gone", displayName: "Gone", state: "DELETE_REQUESTED" },
              ],
              nextPageToken: "p2",
            }),
    });
    expect(await c.listProjects()).toEqual([
      { projectId: "example-a", name: "A" },
      { projectId: "example-b", name: "B" },
    ]);
    expect(calls[0]!.url.startsWith("https://cloudresourcemanager.googleapis.com/v3/projects:search")).toBe(true);
    expect(calls[0]!.headers.authorization).toBe("Bearer tok");
    expect(calls[0]!.headers["x-goog-user-project"]).toBeUndefined();
  });

  it("gets one project, and maps no access to a setup project list fix", async () => {
    const ok = client({ "GET /v3/projects/example-a": () => jsonResponse({ projectId: "example-a", displayName: "A" }) });
    expect(await ok.c.getProject("example-a")).toEqual({ projectId: "example-a", name: "A" });
    const denied = client({ "GET /v3/projects/nope": () => jsonResponse({ error: { code: 403, message: "denied", status: "PERMISSION_DENIED" } }, 403) });
    await expect(denied.c.getProject("nope")).rejects.toMatchObject({ code: "NOT_FOUND", fix: "admobctl setup project list" });
  });

  it("reads each service's state", async () => {
    const { c, calls } = client({
      "GET /services/admob.googleapis.com": () => jsonResponse({ name: "projects/1/services/admob.googleapis.com", state: "ENABLED" }),
      "GET /services/adsense.googleapis.com": () => jsonResponse({ name: "projects/1/services/adsense.googleapis.com", state: "DISABLED" }),
    });
    expect(await c.serviceStates("example-a", ["admob.googleapis.com", "adsense.googleapis.com"])).toEqual({
      "admob.googleapis.com": "ENABLED",
      "adsense.googleapis.com": "DISABLED",
    });
    expect(calls[0]!.url).toBe("https://serviceusage.googleapis.com/v1/projects/example-a/services/admob.googleapis.com");
  });

  it("enables services and polls the operation until done", async () => {
    let polls = 0;
    const { c, calls } = client({
      "POST /services:batchEnable": () => jsonResponse({ name: "operations/acat.op1", done: false }),
      "GET /v1/operations/acat.op1": () => jsonResponse({ name: "operations/acat.op1", done: ++polls >= 2 }),
    });
    await c.enableServices("example-a", ["adsense.googleapis.com"]);
    const post = calls.find((x) => x.method === "POST")!;
    expect(post.url).toBe("https://serviceusage.googleapis.com/v1/projects/example-a/services:batchEnable");
    expect(post.body).toEqual({ serviceIds: ["adsense.googleapis.com"] });
    expect(polls).toBe(2);
  });

  it("returns at once when the enable operation is already done", async () => {
    const { c, calls } = client({ "POST /services:batchEnable": () => jsonResponse({ name: "operations/x", done: true }) });
    await c.enableServices("example-a", ["adsense.googleapis.com"]);
    expect(calls).toHaveLength(1);
  });

  it("surfaces an operation error", async () => {
    const { c } = client({
      "POST /services:batchEnable": () => jsonResponse({ name: "operations/x", done: true, error: { code: 7, message: "Billing required" } }),
    });
    await expect(c.enableServices("example-a", ["x.googleapis.com"])).rejects.toMatchObject({ code: "API_ERROR", message: expect.stringMatching(/Billing required/) });
  });

  it("times out a stuck operation with a status fix", async () => {
    const { c } = client({
      "POST /services:batchEnable": () => jsonResponse({ name: "operations/x", done: false }),
      "GET /v1/operations/x": () => jsonResponse({ name: "operations/x", done: false }),
    });
    await expect(c.enableServices("example-a", ["x.googleapis.com"])).rejects.toMatchObject({ code: "API_ERROR", fix: "admobctl setup status" });
  });
});
