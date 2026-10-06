import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli/program.js";
import type { TokenProvider } from "../src/core/auth/types.js";
import { loadConfig, saveConfig, type ProfileConfig } from "../src/core/config.js";
import type { Exec } from "../src/core/exec.js";
import { fakeFetch, fixture, jsonResponse, noSleep } from "./helpers.js";

const S = (n: string) => `https://www.googleapis.com/auth/${n}`;

async function cli(
  args: string[],
  o: { isTTY?: boolean; profile?: ProfileConfig; scopes?: string[]; signedOut?: boolean; adsense?: "ENABLED" | "DISABLED"; quotaProject?: string; mode?: "adc" | "oauth"; profileName?: string } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "admobctl-setup-cli-"));
  saveConfig(dir, { profiles: { [o.profileName ?? "default"]: o.profile ?? {} } });
  const f = fakeFetch({
    "POST /tokeninfo": () =>
      o.signedOut ? new Response("", { status: 400 }) : jsonResponse({ scope: (o.scopes ?? [S("admob.readonly"), S("cloud-platform")]).join(" "), expires_in: "3000" }),
    "GET /v1/accounts?": () => jsonResponse(fixture("accounts.json")),
    "GET /apps": (c) => jsonResponse(fixture(c.url.includes("pageToken=page2") ? "apps-page2.json" : "apps-page1.json")),
    "GET /adSources": () => jsonResponse(fixture("ad-sources.json")),
    "GET /mediationGroups": () => jsonResponse(fixture("mediation-groups.json")),
    "GET /v3/projects:search": () => jsonResponse({ projects: [{ projectId: "example-a", displayName: "A", state: "ACTIVE" }] }),
    "GET /v3/projects/example-a": () => jsonResponse({ projectId: "example-a", displayName: "A" }),
    "GET /services/admob.googleapis.com": () => jsonResponse({ state: "ENABLED" }),
    "GET /services/adsense.googleapis.com": () => jsonResponse({ state: o.adsense ?? "DISABLED" }),
    "POST /services:batchEnable": () => jsonResponse({ name: "operations/x", done: true }),
  });
  const token: TokenProvider = {
    mode: o.mode ?? "adc",
    getToken: async () => {
      if (o.signedOut) throw Object.assign(new Error("No gcloud Application Default Credentials found."), {});
      return "t";
    },
    quotaProject: () => o.quotaProject,
  };
  const execCalls: string[][] = [];
  const exec: Exec = async (cmd, a) => {
    execCalls.push([cmd, ...a]);
    return { code: 0, stdout: "", stderr: "" };
  };
  let stdout = "";
  let stderr = "";
  const code = await run(["node", "admobctl", ...args], {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    isTTY: o.isTTY ?? false,
    service: { configDir: dir, tokenProvider: token, fetch: f.fetch, sleep: noSleep, exec },
  });
  return { code, stdout, stderr, calls: f.calls, execCalls, profile: () => loadConfig(dir).profiles[o.profileName ?? "default"]! };
}

describe("admobctl setup", () => {
  it("setup status lists checks with fix_command and the next command", async () => {
    const r = await cli(["setup", "status", "-o", "json"], { profile: { features: ["read", "payments"] }, quotaProject: "example-a", scopes: [S("admob.readonly"), S("adsense.readonly"), S("cloud-platform")] });
    const out = JSON.parse(r.stdout);
    expect(out.checks.find((c: { id: string }) => c.id === "apis")).toMatchObject({ status: "fail", fix_command: "admobctl setup apis --features payments --yes" });
    expect(out.next_command).toBe("admobctl setup apis --features payments --yes");
    expect(r.code).toBe(1);
  });

  it("auth doctor is the same report", async () => {
    const r = await cli(["auth", "doctor", "-o", "json"], { quotaProject: "example-a" });
    expect(JSON.parse(r.stdout).checks.some((c: { id: string }) => c.id === "apis")).toBe(true);
  });

  it("setup apis is a dry run without --yes", async () => {
    const r = await cli(["setup", "apis", "--features", "payments"], { quotaProject: "example-a" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("adsense.googleapis.com");
    expect(r.stderr).toContain("Next: admobctl setup apis --features payments --yes");
    expect(r.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("setup apis --yes enables the APIs", async () => {
    const r = await cli(["setup", "apis", "--features", "payments", "--yes"], { quotaProject: "example-a" });
    expect(r.code, r.stderr).toBe(0);
    expect(r.calls.find((c) => c.method === "POST")!.body).toEqual({ serviceIds: ["adsense.googleapis.com"] });
  });

  it("setup project list and use", async () => {
    const list = await cli(["setup", "project", "list", "-o", "json"]);
    expect(JSON.parse(list.stdout)).toEqual([{ projectId: "example-a", name: "A" }]);
    const use = await cli(["setup", "project", "use", "example-a", "--yes"]);
    expect(use.code, use.stderr).toBe(0);
    expect(use.profile().quotaProject).toBe("example-a");
  });

  it("guided setup without a terminal stops at the sign-in with the next command", async () => {
    const r = await cli(["setup", "--yes"], { signedOut: true });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("Next: admobctl setup login --yes");
    expect(r.execCalls).toEqual([]);
  });

  it("setup login --yes at a terminal runs the gcloud sign-in", async () => {
    const r = await cli(["setup", "login", "--features", "payments", "--yes"], { isTTY: true, signedOut: true });
    expect(r.code, r.stderr).toBe(0);
    expect(r.execCalls.at(-1)!.slice(0, 4)).toEqual(["gcloud", "auth", "application-default", "login"]);
    expect(r.profile().features).toEqual(["read", "payments"]);
  });
});

it("setup apis preserves an explicit project across parent/subcommand options", async () => {
  const r = await cli(["setup", "apis", "--project", "example-a", "--features", "payments"], { quotaProject: "example-other" });
  expect(r.code, r.stderr).toBe(0);
  expect(r.calls.filter((c) => c.url.includes("serviceusage")).every((c) => c.url.includes("/projects/example-a/"))).toBe(true);
  expect(r.stderr).toContain("--project example-a --yes");
  expect(r.profile().quotaProject).toBeUndefined();
});

it("setup login refuses OAuth without a terminal before starting browser login", async () => {
  const r = await cli(["setup", "login", "--features", "payments", "--yes"], { mode: "oauth", signedOut: true });
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("must run in a terminal");
  expect(r.execCalls).toEqual([]);
  expect(r.profile().features).toBeUndefined();
});

it("CLI error fixes keep the selected profile", async () => {
  const r = await cli(["--profile", "work", "setup", "login", "--yes"], { profileName: "work", signedOut: true });
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("admobctl --profile work setup login --yes");
});

it("setup apis uses its explicit consumer project when the parent also has a project", async () => {
  const r = await cli(["setup", "--project", "example-parent", "apis", "--project", "example-a", "--features", "payments"], { quotaProject: "example-other" });
  expect(r.code, r.stderr).toBe(0);
  expect(r.calls.filter((c) => c.url.includes("serviceusage")).every((c) => c.url.includes("/projects/example-a/"))).toBe(true);
  expect(r.profile().quotaProject).toBeUndefined();
});
