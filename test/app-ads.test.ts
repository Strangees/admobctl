import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appAdsHost, checkAppAds, GOOGLE_CERT_ID, parseAppAds } from "../src/core/app-ads.js";
import { saveConfig, type ProfileConfig } from "../src/core/config.js";
import { AdmobService } from "../src/core/service.js";
import type { TokenProvider } from "../src/core/auth/types.js";
import { fakeFetch, fixture, jsonResponse, noSleep, type RecordedCall } from "./helpers.js";

const token: TokenProvider = { mode: "adc", getToken: async () => "t", quotaProject: () => "qp" };
const PUB = "pub-0000000000000001";
const LINE = `google.com, ${PUB}, DIRECT, ${GOOGLE_CERT_ID}`;

const text = (body: string, status = 200, type = "text/plain") => new Response(body, { status, headers: { "content-type": type } });

function service(routes: Parameters<typeof fakeFetch>[0], website?: string | ProfileConfig) {
  const dir = mkdtempSync(join(tmpdir(), "admobctl-app-ads-"));
  if (website) saveConfig(dir, { profiles: { default: typeof website === "string" ? { website } : website } });
  const f = fakeFetch({
    "GET /v1/accounts?": () => jsonResponse(fixture("accounts.json")),
    "GET /apps": (c) => jsonResponse(fixture(c.url.includes("pageToken=page2") ? "apps-page2.json" : "apps-page1.json")),
    "GET itunes.apple.com/lookup": () => jsonResponse(fixture("itunes-lookup.json")),
    ...routes,
  });
  const svc = AdmobService.create({}, { configDir: dir, tokenProvider: token, fetch: f.fetch, sleep: noSleep });
  return { svc, calls: f.calls };
}

const appAdsCalls = (calls: RecordedCall[]) => calls.filter((c) => c.url.endsWith("/app-ads.txt")).map((c) => c.url);

describe("parseAppAds", () => {
  it("reads records, skipping comments, blank lines and variables", () => {
    const records = parseAppAds(
      [
        "# ads for example.com",
        "contact=ads@example.com",
        "",
        `Google.com , ${PUB.toUpperCase()} ,direct, ${GOOGLE_CERT_ID} # admob`,
        "othernetwork.com, 123, RESELLER",
      ].join("\r\n"),
    );
    expect(records).toEqual([
      { domain: "google.com", publisherId: PUB, relationship: "DIRECT", certId: GOOGLE_CERT_ID, line: 4 },
      { domain: "othernetwork.com", publisherId: "123", relationship: "RESELLER", line: 5 },
    ]);
  });

  it("ignores lines with too few fields", () => {
    expect(parseAppAds("google.com, pub-1\njust text")).toEqual([]);
  });

  it("drops IAB extension fields after a semicolon", () => {
    expect(parseAppAds(`google.com, ${PUB}, DIRECT;ext\ngoogle.com, ${PUB}, DIRECT, ${GOOGLE_CERT_ID};ext=1`)).toEqual([
      { domain: "google.com", publisherId: PUB, relationship: "DIRECT", line: 1 },
      { domain: "google.com", publisherId: PUB, relationship: "DIRECT", certId: GOOGLE_CERT_ID, line: 2 },
    ]);
  });

  it("splits lines on a bare CR too", () => {
    expect(parseAppAds(`# old Mac line endings\r${LINE}\rothernetwork.com, 123, RESELLER`).map((r) => [r.domain, r.line])).toEqual([
      ["google.com", 2],
      ["othernetwork.com", 3],
    ]);
  });
});

describe("appAdsHost", () => {
  it("keeps only the hostname and drops a leading www. or m.", () => {
    expect(appAdsHost("https://www.example.com/apps?x=1")).toBe("example.com");
    expect(appAdsHost("http://m.example.com")).toBe("example.com");
    expect(appAdsHost("https://apps.example.com/")).toBe("apps.example.com");
  });

  it("accepts a bare domain", () => {
    expect(appAdsHost("Example.com")).toBe("example.com");
  });

  it("returns undefined for something that is not a website", () => {
    expect(appAdsHost("not a url")).toBeUndefined();
  });
});

describe("checkAppAds", () => {
  it("finds the iOS developer website in the App Store listing and accepts a DIRECT line", async () => {
    const { svc, calls } = service({ "GET https://example.com/app-ads.txt": () => text(`${LINE}\n`) });
    const res = await checkAppAds(svc, { app: "example-quiz-ios" });
    expect(calls.find((c) => c.url.includes("itunes.apple.com"))!.url).toContain("id=100000001");
    expect(res.publisherId).toBe(PUB);
    expect(res.expectedLine).toBe(LINE);
    expect(res.apps).toEqual([
      expect.objectContaining({
        app: "example-quiz-ios",
        status: "ok",
        website: "https://www.example.com/apps",
        websiteSource: "store",
        checked: ["https://example.com/app-ads.txt"],
      }),
    ]);
  });

  it("uses the configured website for Android and fetches each host once", async () => {
    const { svc, calls } = service({ "GET https://example.com/app-ads.txt": () => text(LINE) }, "example.com");
    const res = await checkAppAds(svc, {});
    const byApp = Object.fromEntries(res.apps.map((a) => [a.app, a]));
    expect(byApp["example-quiz-android"]).toMatchObject({ status: "ok", websiteSource: "config" });
    expect(byApp["example-quiz-ios"]).toMatchObject({ status: "ok", websiteSource: "store" });
    expect(appAdsCalls(calls)).toEqual(["https://example.com/app-ads.txt"]);
  });

  it("lets --website stand in for Android, ahead of config", async () => {
    const { svc } = service({ "GET https://other.example/app-ads.txt": () => text(LINE) }, "example.com");
    const res = await checkAppAds(svc, { app: "example-quiz-android", website: "https://other.example" });
    expect(res.apps[0]).toMatchObject({ status: "ok", websiteSource: "flag", website: "https://other.example" });
  });

  it("uses a per-app website from config ahead of the profile-wide one", async () => {
    const { svc, calls } = service(
      { "GET https://other.example/app-ads.txt": () => text(LINE) },
      { website: "example.com", websites: { "example-quiz-android": "https://www.other.example" } },
    );
    const res = await checkAppAds(svc, { app: "example-quiz-android" });
    expect(res.apps[0]).toMatchObject({ status: "ok", websiteSource: "config", website: "https://www.other.example" });
    expect(appAdsCalls(calls)).toEqual(["https://other.example/app-ads.txt"]);
  });

  it("also finds a per-app website keyed by app ID", async () => {
    const { svc } = service(
      { "GET https://other.example/app-ads.txt": () => text(LINE) },
      { websites: { "ca-app-pub-0000000000000001~2222222222": "other.example" } },
    );
    const res = await checkAppAds(svc, { app: "example-quiz-android" });
    expect(res.apps[0]).toMatchObject({ status: "ok", website: "other.example" });
  });

  it("lets --website override a per-app website for this run", async () => {
    const { svc } = service(
      { "GET https://example.com/app-ads.txt": () => text(LINE) },
      { websites: { "example-quiz-android": "other.example" } },
    );
    const res = await checkAppAds(svc, { app: "example-quiz-android", website: "example.com" });
    expect(res.apps[0]).toMatchObject({ status: "ok", websiteSource: "flag" });
  });

  it("says the website is unknown for Android without --website or config", async () => {
    const { svc } = service({});
    const res = await checkAppAds(svc, { app: "example-quiz-android" });
    expect(res.apps[0]).toMatchObject({ status: "unknown-website", checked: [] });
    expect(res.apps[0]!.detail).toMatch(/--website/);
  });

  it("skips apps that are not linked to a store", async () => {
    const { svc } = service({});
    const res = await checkAppAds(svc, { app: "sample-timer-focus-breaks-ios" });
    expect(res.apps[0]).toMatchObject({ status: "not-linked", checked: [] });
  });

  it("flags an App Store listing without a marketing URL", async () => {
    const { svc } = service({
      "GET itunes.apple.com/lookup": () => jsonResponse({ resultCount: 1, results: [{ trackId: 100000001, trackName: "Example Quiz" }] }),
    }, "example.com");
    const res = await checkAppAds(svc, { app: "example-quiz-ios" });
    expect(res.apps[0]).toMatchObject({ status: "no-website", checked: [] });
    expect(res.apps[0]!.detail).toMatch(/marketing URL/);
  });

  it("falls back to the configured website when the App Store lookup finds no listing", async () => {
    const { svc } = service({
      "GET itunes.apple.com/lookup": () => jsonResponse({ resultCount: 0, results: [] }),
      "GET https://example.com/app-ads.txt": () => text(LINE),
    }, "example.com");
    const res = await checkAppAds(svc, { app: "example-quiz-ios" });
    expect(res.apps[0]).toMatchObject({ status: "ok", websiteSource: "config" });
    expect(res.apps[0]!.notes.join(" ")).toMatch(/App Store/);
  });

  it("reports a missing file after trying https and then http", async () => {
    const { svc, calls } = service({
      "GET https://example.com/app-ads.txt": () => text("Not found", 404),
      "GET http://example.com/app-ads.txt": () => text("Not found", 404),
    });
    const res = await checkAppAds(svc, { app: "example-quiz-ios" });
    expect(res.apps[0]).toMatchObject({ status: "missing-file" });
    expect(res.apps[0]!.detail).toMatch(/404/);
    expect(appAdsCalls(calls)).toEqual(["https://example.com/app-ads.txt", "http://example.com/app-ads.txt"]);
  });

  it("treats 410 Gone as a missing file", async () => {
    const { svc } = service({
      "GET https://example.com/app-ads.txt": () => text("Gone", 410),
      "GET http://example.com/app-ads.txt": () => text("Gone", 410),
    });
    const res = await checkAppAds(svc, { app: "example-quiz-ios" });
    expect(res.apps[0]).toMatchObject({ status: "missing-file" });
  });

  it.each([401, 403, 429, 500, 503])("reports HTTP %i as blocked or a server error, not a missing file", async (status) => {
    const { svc } = service({
      "GET https://example.com/app-ads.txt": () => text("Nope", status),
      "GET http://example.com/app-ads.txt": () => text("Nope", status),
    });
    const res = await checkAppAds(svc, { app: "example-quiz-ios" });
    expect(res.apps[0]).toMatchObject({ status: "unreachable" });
    expect(res.apps[0]!.detail).toContain(`HTTP ${status}`);
    expect(res.apps[0]!.detail).toMatch(status >= 500 ? /server error/ : /blocked/);
  });

  it("identifies itself with a descriptive User-Agent", async () => {
    const { svc, calls } = service({ "GET https://example.com/app-ads.txt": () => text(LINE) });
    await checkAppAds(svc, { app: "example-quiz-ios" });
    const call = calls.find((c) => c.url.endsWith("/app-ads.txt"))!;
    expect(call.headers["user-agent"]).toMatch(/^admobctl\/\S+ \(\+https:\/\/github\.com\/Strangees\/admobctl\)$/);
  });

  it("accepts a file served only over http", async () => {
    const { svc } = service({
      "GET https://example.com/app-ads.txt": () => { throw new TypeError("fetch failed"); },
      "GET http://example.com/app-ads.txt": () => text(LINE),
    });
    const res = await checkAppAds(svc, { app: "example-quiz-ios" });
    expect(res.apps[0]).toMatchObject({ status: "ok", fileUrl: "http://example.com/app-ads.txt" });
  });

  it("catches a site that answers with an HTML page instead of the file", async () => {
    const page = "<!doctype html><html><body>My app</body></html>";
    const { svc } = service({
      "GET https://example.com/app-ads.txt": () => text(page, 200, "text/html; charset=utf-8"),
      "GET http://example.com/app-ads.txt": () => text(page, 200, "text/html"),
    });
    const res = await checkAppAds(svc, { app: "example-quiz-ios" });
    expect(res.apps[0]).toMatchObject({ status: "html" });
  });

  it("flags a file without a line for this publisher ID, naming the IDs it does have", async () => {
    const { svc } = service({ "GET https://example.com/app-ads.txt": () => text(`google.com, pub-0000000000000009, DIRECT, ${GOOGLE_CERT_ID}`) });
    const res = await checkAppAds(svc, { app: "example-quiz-ios" });
    expect(res.apps[0]).toMatchObject({ status: "no-line" });
    expect(res.apps[0]!.detail).toContain("pub-0000000000000009");
  });

  it("says to drop the ca-app- prefix when the line uses the app ID form of this publisher ID", async () => {
    const { svc } = service({ "GET https://example.com/app-ads.txt": () => text(`google.com, ca-app-${PUB}, DIRECT, ${GOOGLE_CERT_ID}`) });
    const res = await checkAppAds(svc, { app: "example-quiz-ios" });
    expect(res.apps[0]).toMatchObject({ status: "no-line" });
    expect(res.apps[0]!.detail).toContain(`ca-app-${PUB} (line 1)`);
    expect(res.apps[0]!.detail).toContain(`use ${PUB}, not ca-app-${PUB}`);
  });

  it("accepts a DIRECT line that carries an extension field", async () => {
    const { svc } = service({ "GET https://example.com/app-ads.txt": () => text(`google.com, ${PUB}, DIRECT;ext`) });
    const res = await checkAppAds(svc, { app: "example-quiz-ios" });
    expect(res.apps[0]).toMatchObject({ status: "ok", notes: [] });
  });

  it("names at most three other publisher IDs", async () => {
    const lines = [1, 2, 3, 4, 5].map((n) => `google.com, pub-000000000000000${n + 1}, DIRECT`).join("\n");
    const { svc } = service({ "GET https://example.com/app-ads.txt": () => text(lines) });
    const res = await checkAppAds(svc, { app: "example-quiz-ios" });
    expect(res.apps[0]!.detail).toMatch(/pub-0000000000000004 and 2 more\)/);
    expect(res.apps[0]!.detail).not.toContain("pub-0000000000000005");
  });

  it("flags a RESELLER-only line", async () => {
    const { svc } = service({ "GET https://example.com/app-ads.txt": () => text(`google.com, ${PUB}, RESELLER, ${GOOGLE_CERT_ID}`) });
    const res = await checkAppAds(svc, { app: "example-quiz-ios" });
    expect(res.apps[0]).toMatchObject({ status: "reseller-only" });
  });

  it("notes a certification ID that is not Google's but still passes the line", async () => {
    const { svc } = service({ "GET https://example.com/app-ads.txt": () => text(`google.com, ${PUB}, DIRECT, abc123`) });
    const res = await checkAppAds(svc, { app: "example-quiz-ios" });
    expect(res.apps[0]).toMatchObject({ status: "ok" });
    expect(res.apps[0]!.notes.join(" ")).toContain(GOOGLE_CERT_ID);
  });

  it("reports an unreachable site", async () => {
    const boom = () => { throw new TypeError("getaddrinfo ENOTFOUND example.com"); };
    const { svc } = service({ "GET https://example.com/app-ads.txt": boom, "GET http://example.com/app-ads.txt": boom });
    const res = await checkAppAds(svc, { app: "example-quiz-ios" });
    expect(res.apps[0]).toMatchObject({ status: "unreachable" });
    expect(res.apps[0]!.detail).toMatch(/ENOTFOUND/);
  });

  it("summarises problems and the line to add", async () => {
    const { svc } = service({
      "GET https://example.com/app-ads.txt": () => text("", 404),
      "GET http://example.com/app-ads.txt": () => text("", 404),
    }, "example.com");
    const res = await checkAppAds(svc, {});
    expect(res.problems).toBe(2);
    expect(res.summary.join("\n")).toContain(LINE);
  });
});
