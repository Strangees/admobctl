import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli/program.js";
import type { TokenProvider } from "../src/core/auth/types.js";
import { fakeFetch, fixture, jsonResponse, noSleep, type RecordedCall } from "./helpers.js";

const token: TokenProvider = { mode: "adc", getToken: async () => "t", quotaProject: () => "qp" };

async function cli(args: string[], opts: { isTTY?: boolean; dir?: string; scopeError?: boolean } = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "admobctl-cliw-"));
  const f = fakeFetch({
    "GET /v1/accounts?": () => jsonResponse(fixture("accounts.json")),
    "GET /apps": (c: RecordedCall) => jsonResponse(fixture(c.url.includes("pageToken=page2") ? "apps-page2.json" : "apps-page1.json")),
    "GET /adUnits?": () => jsonResponse(fixture("ad-units.json")),
    "GET /v1beta/accounts/pub-0000000000000001/adSources?": () => jsonResponse(fixture("ad-sources.json")),
    "GET /adSources/1000000000000000001/adapters": () => jsonResponse(fixture("adapters.json")),
    "GET /v1beta/accounts/pub-0000000000000001/mediationGroups": () => jsonResponse(fixture("mediation-groups.json")),
    "POST /v1beta/accounts/pub-0000000000000001/adUnits": (c) =>
      jsonResponse({ ...(c.body as object), name: "accounts/pub-0000000000000001/adUnits/9000000009", adUnitId: "ca-app-pub-0000000000000001/9000000009" }),
    "POST /v1beta/accounts/pub-0000000000000001/adUnitMappings:batchCreate": (c) =>
      jsonResponse({ adUnitMappings: (c.body as { requests: Array<{ adUnitMapping: object }> }).requests.map((r) => r.adUnitMapping) }),
    "PATCH /mediationGroups/1000000001": (c) =>
      opts.scopeError
        ? jsonResponse(
            {
              error: {
                code: 403,
                message: "Request had insufficient authentication scopes.",
                status: "PERMISSION_DENIED",
                details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }],
              },
            },
            403,
          )
        : jsonResponse({ name: "accounts/pub-0000000000000001/mediationGroups/1000000001", echo: c.body }),
    "POST /mediationAbExperiments:stop": () => jsonResponse({ name: "accounts/pub-0000000000000001/mediationGroups/1000000002/mediationAbExperiment/1", state: "ENDED" }),
  });
  let stdout = "";
  let stderr = "";
  const code = await run(["node", "admobctl", ...args], {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    isTTY: opts.isTTY ?? false,
    service: { configDir: dir, tokenProvider: token, fetch: f.fetch, sleep: noSleep, now: () => new Date("2026-10-02T08:00:00Z") },
  });
  return { code, stdout, stderr, calls: f.calls, dir };
}

const writes = (calls: RecordedCall[]) => calls.filter((c) => c.method !== "GET");

describe("cli write commands", () => {
  it("prints a plan and sends nothing without --yes", async () => {
    const r = await cli(["ad-units", "create", "--app", "example-quiz-ios", "--name", "Level end", "--format", "interstitial"], { isTTY: true });
    expect(r.code, r.stderr).toBe(0);
    expect(writes(r.calls)).toEqual([]);
    expect(r.stdout).toMatch(/Create INTERSTITIAL ad unit "Level end" in example-quiz-ios/);
    expect(r.stdout).toMatch(/POST https:\/\/admob\.googleapis\.com\/v1beta\/accounts\/pub-0000000000000001\/adUnits/);
    expect(r.stderr).toMatch(/Dry run: nothing was sent\. Re-run with --yes to apply\./);
    expect(existsSync(join(r.dir, "audit.log"))).toBe(false);
  });

  it("applies with --yes, prints the result and writes the audit log", async () => {
    const r = await cli(["ad-units", "create", "--app", "example-quiz-ios", "--name", "Level end", "--format", "interstitial", "--yes", "-o", "json"]);
    expect(r.code, r.stderr).toBe(0);
    expect(writes(r.calls)).toHaveLength(1);
    const out = JSON.parse(r.stdout);
    expect(out.applied).toBe(true);
    expect(out.results[0].adUnitId).toBe("ca-app-pub-0000000000000001/9000000009");
    expect(readFileSync(join(r.dir, "audit.log"), "utf8")).toMatch(/"action":"Create ad unit"/);
  });

  it("returns the plan as JSON when piped", async () => {
    const r = await cli(["mediation-groups", "set-line", "Banners", "Waterfall 3.00", "--cpm", "2.5"]);
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.applied).toBe(false);
    expect(out.plans[0]).toMatchObject({ method: "PATCH", query: { updateMask: 'mediation_group_lines["4000000000000003"].cpm_micros' } });
  });

  it("maps an ad unit with --set label=value", async () => {
    const r = await cli(["ad-units", "map", "Quiz banner", "--ad-source", "Example Bidder", "--adapter", "Example Bidder (iOS)", "--set", "Placement ID=pl-1", "-o", "json"]);
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).plans[0].body).toEqual({ adapterId: "2000000001", adUnitConfigurations: { "3000000001": "pl-1" } });
  });

  it("creates mappings in batches from a file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "admobctl-cliw-"));
    const file = join(dir, "mappings.json");
    writeFileSync(file, JSON.stringify([{ adUnit: "Quiz banner", adSource: "Example Bidder", adapter: "2000000001", name: "m1", settings: { "Placement ID": "p1" } }]));
    const r = await cli(["ad-units", "map-batch", "--file", file, "--yes", "-o", "json"], { dir });
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).results[0].adUnitMappings).toHaveLength(1);
  });

  it("rejects a malformed batch file before sending anything", async () => {
    const dir = mkdtempSync(join(tmpdir(), "admobctl-cliw-"));
    const file = join(dir, "mappings.json");
    writeFileSync(file, JSON.stringify([{ adUnit: "Quiz banner" }]));
    const r = await cli(["ad-units", "map-batch", "--file", file, "--yes"], { dir });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/entry 1.*adSource/);
    expect(writes(r.calls)).toEqual([]);
  });

  it("stops an A/B experiment keeping a variant", async () => {
    const r = await cli(["mediation-groups", "experiment", "stop", "Interstitials", "--keep", "b", "--yes", "-o", "json"]);
    expect(r.code, r.stderr).toBe(0);
    expect(writes(r.calls)[0]!.body).toEqual({ variantChoice: "VARIANT_CHOICE_B" });
  });

  it("shows the write login command when the token lacks the monetization scope", async () => {
    const r = await cli(["mediation-groups", "set-line", "Banners", "Waterfall 3.00", "--state", "disabled", "--yes"], { scopeError: true, isTTY: true });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/admob\.monetization/);
    expect(r.stderr).toMatch(/fix: gcloud auth application-default login --scopes=.*admob\.monetization/);
  });
});
