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

function setup() {
  const f = fakeFetch({
    "GET /v1/accounts?": () => jsonResponse(fixture("accounts.json")),
    "GET /apps": (c) => jsonResponse(fixture(c.url.includes("pageToken=page2") ? "apps-page2.json" : "apps-page1.json")),
    "GET /adUnits": () => jsonResponse(fixture("ad-units.json")),
    "GET /v1beta/accounts/pub-0000000000000001/adSources?": () => jsonResponse(fixture("ad-sources.json")),
    "GET /v1beta/accounts/pub-0000000000000001/mediationGroups": () => jsonResponse(fixture("mediation-groups.json")),
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
