import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli/program.js";
import type { TokenProvider } from "../src/core/auth/types.js";
import { exportMediationGroups } from "../src/core/mediation-export.js";
import { AdmobService } from "../src/core/service.js";
import { planCreateMediationGroup } from "../src/core/write.js";
import { fakeFetch, fixture, jsonResponse, noSleep } from "./helpers.js";

const token: TokenProvider = { mode: "adc", getToken: async () => "t", quotaProject: () => "qp" };
const UNIT = "ca-app-pub-0000000000000001/9000000001";

type Groups = { mediationGroups: Array<{ displayName: string; mediationGroupLines: Record<string, Record<string, unknown>> }> };
type Sources = { adSources: Array<{ title: string }> };

function setup(opts: { groups?: (g: Groups) => unknown; sources?: (s: Sources) => unknown; sourcesDenied?: boolean } = {}) {
  const f = fakeFetch({
    "GET /v1/accounts?": () => jsonResponse(fixture("accounts.json")),
    "GET /apps": (c) => jsonResponse(fixture(c.url.includes("pageToken=page2") ? "apps-page2.json" : "apps-page1.json")),
    "GET /adUnits": () => jsonResponse(fixture("ad-units.json")),
    "GET /v1beta/accounts/pub-0000000000000001/adSources?": () =>
      opts.sourcesDenied
        ? jsonResponse({ error: { code: 403, message: "The caller does not have permission", status: "PERMISSION_DENIED" } }, 403)
        : jsonResponse(opts.sources ? opts.sources(fixture<Sources>("ad-sources.json")) : fixture("ad-sources.json")),
    "GET /v1beta/accounts/pub-0000000000000001/mediationGroups": () =>
      jsonResponse(opts.groups ? opts.groups(fixture<Groups>("mediation-groups.json")) : fixture("mediation-groups.json")),
  });
  const dir = mkdtempSync(join(tmpdir(), "admobctl-export-"));
  const deps = { configDir: dir, tokenProvider: token, fetch: f.fetch, sleep: noSleep, now: () => new Date("2026-10-02T08:00:00Z") };
  return { svc: AdmobService.create({}, deps), deps, dir, calls: f.calls };
}

describe("exportMediationGroups", () => {
  it("turns a group into JSON that mediation-groups create accepts", async () => {
    const { svc } = setup();
    const { groups, notes } = await exportMediationGroups(svc, { group: "Banners" });
    expect(groups).toEqual([
      {
        displayName: "Banners",
        state: "ENABLED",
        targeting: { platform: "IOS", format: "BANNER", adUnitIds: [UNIT], targetedRegionCodes: ["NO", "SE"], idfaTargeting: "ALL" },
        mediationGroupLines: {
          "-1": {
            displayName: "Bidder floor 1",
            adSourceId: "1000000000000000001",
            cpmMode: "LIVE",
            state: "ENABLED",
            adUnitMappings: { [UNIT]: "accounts/pub-0000000000000001/adUnits/9000000001/adUnitMappings/5000000001" },
          },
          "-2": {
            displayName: "Waterfall 3.00",
            adSourceId: "1000000000000000002",
            cpmMode: "MANUAL",
            cpmMicros: "3000000",
            state: "ENABLED",
            adUnitMappings: { [UNIT]: "accounts/pub-0000000000000001/adUnits/9000000001/adUnitMappings/5000000002" },
          },
        },
      },
    ]);
    expect(notes.join(" ")).toMatch(/AdMob Network line .* left out/);
    // Round trip: the export is a valid input for create.
    const plan = await planCreateMediationGroup(svc, groups[0]);
    expect(plan.summary[0]).toMatch(/"Banners" \(IOS BANNER\) for 1 ad unit\(s\) with 2 line\(s\)/);
  });

  it("keeps the AdMob Network line when asked, and can rename the copy", async () => {
    const { svc } = setup();
    const { groups } = await exportMediationGroups(svc, { group: "1000000001", admobLine: true, name: "Banners (copy)" });
    const g = groups[0] as { displayName: string; mediationGroupLines: Record<string, { displayName: string }> };
    expect(g.displayName).toBe("Banners (copy)");
    expect(Object.values(g.mediationGroupLines).map((l) => l.displayName)).toEqual(["AdMob Network", "Bidder floor 1", "Waterfall 3.00"]);
  });

  it("warns in the create plan when the file brings its own AdMob Network line", async () => {
    const { svc } = setup();
    const { groups } = await exportMediationGroups(svc, { group: "Banners", admobLine: true });
    const plan = await planCreateMediationGroup(svc, groups[0]);
    expect(plan.summary[0]).toMatch(/with 2 line\(s\) besides the AdMob Network line/);
    expect(plan.summary[1]).toMatch(/includes an AdMob Network line/);
    const without = await planCreateMediationGroup(svc, (await exportMediationGroups(svc, { group: "Banners" })).groups[0]);
    expect(without.summary).toHaveLength(1);
  });

  it("counts groups, not lines, when it leaves AdMob Network lines out", async () => {
    const { svc } = setup({
      groups: (g) => {
        const lines = g.mediationGroups[0]!.mediationGroupLines;
        const admob = Object.values(lines).find((l) => l.displayName === "AdMob Network")!;
        lines["9"] = { ...admob, id: "9", displayName: "AdMob Network (second)" };
        g.mediationGroups.length = 1;
        return g;
      },
    });
    const { notes } = await exportMediationGroups(svc, {});
    expect(notes.join(" ")).toMatch(/The AdMob Network line of 1 group was left out/);
  });

  it("tells unreadable ad sources apart from an unrecognised AdMob Network source", async () => {
    const unnamed = await exportMediationGroups(setup({ sources: (s) => ({ adSources: s.adSources.filter((x) => x.title !== "AdMob Network") }) }).svc, { group: "Banners" });
    expect(unnamed.notes.join(" ")).toMatch(/No ad source is titled "AdMob Network"/);
    const denied = await exportMediationGroups(setup({ sourcesDenied: true }).svc, { group: "Banners" });
    expect(denied.notes.join(" ")).toMatch(/Ad sources could not be read/);
  });

  it("exports the original lines of a group with a running experiment and says so", async () => {
    const { svc } = setup();
    const { groups, notes } = await exportMediationGroups(svc, { group: "Interstitials" });
    const g = groups[0] as { mediationGroupLines: Record<string, unknown> };
    // Variant A is the AdMob Network line (left out); variant B is the treatment.
    expect(g.mediationGroupLines).toEqual({});
    expect(notes.join(" ")).toMatch(/Interstitials has a running A\/B experiment; its 1 treatment line \(variant B\) was left out/);
  });

  it("exports every group without an argument, and rejects --name then", async () => {
    const { svc } = setup();
    const { groups } = await exportMediationGroups(svc, {});
    expect(groups.map((g) => (g as { displayName: string }).displayName)).toEqual(["Banners", "Interstitials"]);
    await expect(exportMediationGroups(svc, { name: "x" })).rejects.toThrow(/--name needs a group/);
    await expect(exportMediationGroups(svc, { group: "nope" })).rejects.toThrow(/Unknown mediation group/);
  });
});

describe("cli mediation-groups export", () => {
  async function cli(args: string[]) {
    const s = setup();
    let stdout = "";
    let stderr = "";
    const code = await run(["node", "admobctl", "mediation-groups", "export", ...args], { stdout: (x) => (stdout += x), stderr: (x) => (stderr += x), isTTY: true, service: s.deps });
    return { code, stdout, stderr, dir: s.dir, calls: s.calls };
  }

  it("prints one group as a JSON object, whatever the output format, and sends no write", async () => {
    const r = await cli(["Banners"]);
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).displayName).toBe("Banners");
    expect(r.stderr).toMatch(/AdMob Network line/);
    expect(r.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("prints all groups as an array and writes --out privately", async () => {
    const all = await cli([]);
    expect(JSON.parse(all.stdout)).toHaveLength(2);
    const out = join(all.dir, "banners.json");
    const r = await cli(["Banners", "--out", out]);
    expect(r.stdout).toBe("");
    expect(JSON.parse(readFileSync(out, "utf8")).displayName).toBe("Banners");
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(r.stderr).toMatch(/Wrote /);
  });
});
