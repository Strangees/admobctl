import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli/program.js";
import type { TokenProvider } from "../src/core/auth/types.js";
import { lint } from "../src/core/lint.js";
import { AdmobService } from "../src/core/service.js";
import { fakeFetch, fixture, jsonResponse, noSleep, synthReport, type RecordedCall } from "./helpers.js";

const token: TokenProvider = { mode: "adc", getToken: async () => "t", quotaProject: () => "qp" };
const unit = (n: number) => `ca-app-pub-0000000000000001/900000000${n}`;
const traffic = (units: number[]) => synthReport(units.map((n) => [{ AD_UNIT: [unit(n), "x"] }, { AD_REQUESTS: 500 }]));

type Groups = { mediationGroups: Array<{ displayName: string; state: string; targeting: { adUnitIds: string[] }; mediationGroupLines: Record<string, { state: string }> }> };
type Apps = { apps: Array<{ appApprovalState?: string }> };

function setup(opts: { units?: number[]; groups?: (g: Groups) => unknown; apps?: (a: Apps) => unknown; betaDenied?: boolean } = {}) {
  const f = fakeFetch({
    "GET /v1/accounts?": () => jsonResponse(fixture("accounts.json")),
    "GET /apps": (c) => {
      const page = fixture<Apps>(c.url.includes("pageToken=page2") ? "apps-page2.json" : "apps-page1.json");
      return jsonResponse(opts.apps && !c.url.includes("pageToken=page2") ? opts.apps(page) : page);
    },
    "GET /adUnits": () => jsonResponse(fixture("ad-units.json")),
    "GET /v1beta/accounts/pub-0000000000000001/adSources?": () => jsonResponse(fixture("ad-sources.json")),
    "GET /v1beta/accounts/pub-0000000000000001/mediationGroups": () =>
      opts.betaDenied
        ? jsonResponse({ error: { code: 403, message: "The caller does not have permission", status: "PERMISSION_DENIED" } }, 403)
        : jsonResponse(opts.groups ? opts.groups(fixture<Groups>("mediation-groups.json")) : fixture("mediation-groups.json")),
    "POST /networkReport:generate": () => jsonResponse(traffic(opts.units ?? [1, 2, 3, 4])),
  });
  const deps = { configDir: mkdtempSync(join(tmpdir(), "admobctl-lint-")), tokenProvider: token, fetch: f.fetch, sleep: noSleep, now: () => new Date("2026-10-02T08:00:00Z") };
  return { svc: AdmobService.create({}, deps), deps, calls: f.calls };
}
const kinds = (r: { findings: Array<{ kind: string; target: string }> }) => r.findings.map((f) => `${f.kind}:${f.target}`);

describe("lint", () => {
  it("asks for 30 days of requests per ad unit and reports what it checked", async () => {
    const { svc, calls } = setup();
    const r = await lint(svc);
    const spec = (calls.find((c: RecordedCall) => c.url.includes("networkReport"))!.body as { reportSpec: { dimensions: string[]; metrics: string[] } }).reportSpec;
    expect(spec).toMatchObject({ dimensions: ["AD_UNIT"], metrics: ["AD_REQUESTS"] });
    expect(r).toMatchObject({ from: "2026-09-02", to: "2026-10-01", checked: { apps: 3, ad_units: 4, mediation_groups: 2 }, problems: 0 });
    // With mediation groups in use, units outside every group are worth a note, not a failure.
    expect(kinds(r)).toEqual(["ungrouped-ad-unit:Quiz banner (Android)", "ungrouped-ad-unit:Timer banner"]);
    expect(r.findings.every((f) => f.severity === "note")).toBe(true);
  });

  it("notes ad units without requests", async () => {
    const r = await lint(setup({ units: [1, 3, 4] }).svc);
    const f = r.findings.find((x) => x.kind === "unused-ad-unit")!;
    expect(f).toMatchObject({ severity: "note", target: "Quiz interstitial", app: "example-quiz-ios" });
    expect(f.message).toMatch(/no ad requests from 2026-09-02 to 2026-10-01/);
    expect(r.problems).toBe(0);
  });

  it("reports groups that target a missing ad unit or cannot serve as problems", async () => {
    const r = await lint(
      setup({
        groups: (g) => {
          g.mediationGroups[0]!.targeting.adUnitIds.push("ca-app-pub-0000000000000001/9999999999");
          for (const line of Object.values(g.mediationGroups[1]!.mediationGroupLines)) line.state = "DISABLED";
          return g;
        },
      }).svc,
    );
    const problems = r.findings.filter((f) => f.severity === "problem");
    expect(problems.map((f) => `${f.kind}:${f.target}`)).toEqual(["missing-ad-unit:Banners", "no-enabled-lines:Interstitials"]);
    expect(problems[0]!.message).toMatch(/9999999999/);
    expect(r.problems).toBe(2);
  });

  it("does not judge disabled groups", async () => {
    const r = await lint(
      setup({
        groups: (g) => {
          g.mediationGroups[1]!.state = "DISABLED";
          for (const line of Object.values(g.mediationGroups[1]!.mediationGroupLines)) line.state = "DISABLED";
          return g;
        },
      }).svc,
    );
    expect(r.problems).toBe(0);
    // Its ad unit is now served by no enabled group.
    expect(kinds(r)).toContain("ungrouped-ad-unit:Quiz interstitial");
  });

  it("reports apps that need action as problems and apps in review as notes", async () => {
    const r = await lint(
      setup({
        apps: (a) => {
          a.apps[0]!.appApprovalState = "ACTION_REQUIRED";
          a.apps[1]!.appApprovalState = "IN_REVIEW";
          return a;
        },
      }).svc,
    );
    expect(r.findings.filter((f) => f.kind.startsWith("app-")).map((f) => [f.kind, f.severity])).toEqual([
      ["app-action-required", "problem"],
      ["app-in-review", "note"],
    ]);
    expect(r.problems).toBe(1);
  });

  it("skips the mediation checks, with a notice, when v1beta is not available", async () => {
    const r = await lint(setup({ betaDenied: true, units: [1, 2, 3] }).svc);
    expect(r.checked.mediation_groups).toBeNull();
    expect(kinds(r)).toEqual(["unused-ad-unit:Timer banner"]);
    expect(r.notices.join(" ")).toMatch(/Mediation groups were not checked.*v1beta/);
  });

  it("limits the findings to one app", async () => {
    const r = await lint(setup({ units: [] }).svc, { app: "example-quiz-android" });
    expect(kinds(r)).toEqual(["unused-ad-unit:Quiz banner (Android)", "ungrouped-ad-unit:Quiz banner (Android)"]);
    expect(r.checked).toMatchObject({ apps: 1, ad_units: 1 });
  });
});

describe("cli lint", () => {
  async function cli(opts: Parameters<typeof setup>[0]) {
    const { deps } = setup(opts);
    let stdout = "";
    const code = await run(["node", "admobctl", "lint"], { stdout: (s) => (stdout += s), stderr: () => {}, isTTY: true, service: deps });
    return { code, stdout };
  }

  it("exits 0 on notes only and 1 on a problem", async () => {
    const notes = await cli({});
    expect(notes.code).toBe(0);
    expect(notes.stdout).toMatch(/note\s+ungrouped-ad-unit/);
    const problem = await cli({ apps: (a) => ((a.apps[0]!.appApprovalState = "ACTION_REQUIRED"), a) });
    expect(problem.code).toBe(1);
    expect(problem.stdout).toMatch(/problem\s+app-action-required/);
  });
});
