import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TokenProvider } from "../src/core/auth/types.js";
import { loadConfig, saveConfig, type ProfileConfig } from "../src/core/config.js";
import type { Exec } from "../src/core/exec.js";
import { AdmobctlError } from "../src/core/errors.js";
import { AdmobService } from "../src/core/service.js";
import { CloudClient } from "../src/core/setup/cloud.js";
import { applyApis, applyLogin, applyProject, planApis, planLogin, planProject, runSetup, type SetupContext } from "../src/core/setup/steps.js";
import { fakeFetch, jsonResponse, noSleep } from "./helpers.js";

const S = (n: string) => `https://www.googleapis.com/auth/${n}`;
const READ_SCOPES = [S("admob.readonly"), S("cloud-platform")];

interface World {
  profile?: ProfileConfig;
  scopes?: string[] | "signed-out";
  quotaProject?: string;
  adsense?: "ENABLED" | "DISABLED";
  isTTY?: boolean;
  gcloud?: boolean;
  mode?: "adc" | "oauth";
}

function world(w: World = {}) {
  const dir = mkdtempSync(join(tmpdir(), "admobctl-steps-"));
  saveConfig(dir, { profiles: { default: w.profile ?? {} } });
  const f = fakeFetch({
    "GET /v3/projects:search": () =>
      jsonResponse({ projects: [{ projectId: "example-a", displayName: "A", state: "ACTIVE" }, { projectId: "example-b", displayName: "B", state: "ACTIVE" }] }),
    "GET /v3/projects/example-a": () => jsonResponse({ projectId: "example-a", displayName: "A" }),
    "GET /services/admob.googleapis.com": () => jsonResponse({ state: "ENABLED" }),
    "GET /services/adsense.googleapis.com": () => jsonResponse({ state: w.adsense ?? "DISABLED" }),
    "POST /services:batchEnable": () => jsonResponse({ name: "operations/x", done: true }),
  });
  const token: TokenProvider = { mode: w.mode ?? "adc", getToken: async () => "t", quotaProject: () => w.quotaProject };
  const svc = AdmobService.create({}, { configDir: dir, tokenProvider: token, fetch: f.fetch, sleep: noSleep });
  const execCalls: Array<{ cmd: string; args: string[] }> = [];
  const exec: Exec = async (cmd, args) => {
    execCalls.push({ cmd, args });
    if (cmd === "gcloud" && args[0] === "--version" && w.gcloud === false) throw new Error("ENOENT");
    return { code: 0, stdout: "", stderr: "" };
  };
  const oauthLogins: Array<{ write: boolean; payments: boolean; cloudPlatform?: boolean }> = [];
  const ctx: SetupContext = {
    svc,
    cloud: new CloudClient({ getToken: async () => "t", fetch: f.fetch, sleep: noSleep }),
    exec,
    interactive: w.isTTY ?? true,
    tokenInfo: async () => {
      if (w.scopes === "signed-out") throw new Error("no credentials");
      return { scopes: w.scopes ?? READ_SCOPES };
    },
    oauthLogin: async (o) => void oauthLogins.push(o),
  };
  const profile = () => loadConfig(dir).profiles.default!;
  return { ctx, calls: f.calls, execCalls, oauthLogins, profile, dir };
}

describe("planLogin", () => {
  it("is done when the token has every scope the features need", async () => {
    const { ctx } = world();
    expect((await planLogin(ctx, ["read"])).status).toBe("done");
  });

  it("plans a gcloud sign-in when signed out", async () => {
    const { ctx } = world({ scopes: "signed-out" });
    const p = await planLogin(ctx, ["read"]);
    expect(p.status).toBe("planned");
    expect(p.summary.join("\n")).toContain(`gcloud auth application-default login --scopes=${S("admob.readonly")},${S("cloud-platform")}`);
    expect(p.next_command).toBe("admobctl setup login --yes");
  });

  it("keeps the write scope a user already has when adding payments", async () => {
    const { ctx } = world({ scopes: [S("admob.readonly"), S("admob.monetization"), S("cloud-platform")] });
    const p = await planLogin(ctx, ["payments"]);
    expect(p.features).toEqual(["read", "write", "payments"]);
    expect(p.scopes).toEqual([S("admob.readonly"), S("admob.monetization"), S("adsense.readonly"), S("cloud-platform")]);
    expect(p.next_command).toBe("admobctl setup login --features write,payments --yes");
  });

  it("includes features stored in the profile", async () => {
    const { ctx } = world({ profile: { features: ["read", "payments"] } });
    const p = await planLogin(ctx, []);
    expect(p.status).toBe("planned");
    expect(p.features).toEqual(["read", "payments"]);
  });

  it("names admobctl auth login in OAuth mode", async () => {
    const { ctx } = world({ mode: "oauth", scopes: [S("admob.readonly")] });
    const p = await planLogin(ctx, ["write"]);
    expect(p.summary.join("\n")).toContain("admobctl auth login --write");
  });
});

describe("applyLogin", () => {
  it("runs gcloud interactively at a terminal and stores the features", async () => {
    const w = world({ scopes: "signed-out" });
    await applyLogin(w.ctx, await planLogin(w.ctx, ["payments"]));
    expect(w.execCalls.map((c) => c.args[0])).toEqual(["--version", "auth"]);
    expect(w.profile().features).toEqual(["read", "payments"]);
  });

  it("refuses without a terminal and names the command to run there", async () => {
    const w = world({ scopes: "signed-out", isTTY: false });
    await expect(applyLogin(w.ctx, await planLogin(w.ctx, []))).rejects.toMatchObject({ code: "USAGE", message: expect.stringContaining("gcloud auth application-default login") });
  });

  it("explains a missing gcloud", async () => {
    const w = world({ scopes: "signed-out", gcloud: false });
    await expect(applyLogin(w.ctx, await planLogin(w.ctx, []))).rejects.toMatchObject({ code: "AUTH_NO_CREDENTIALS", message: expect.stringContaining("cloud.google.com/sdk") });
  });

  it("uses admobctl OAuth in OAuth mode", async () => {
    const w = world({ mode: "oauth", scopes: [S("admob.readonly")] });
    await applyLogin(w.ctx, await planLogin(w.ctx, ["payments"]));
    expect(w.oauthLogins).toEqual([{ write: false, payments: true, cloudPlatform: true }]);
  });
});

describe("project", () => {
  it("is done when a quota project is known", async () => {
    expect((await planProject(world({ quotaProject: "example-a" }).ctx)).status).toBe("done");
  });

  it("asks for a project, listing the choices", async () => {
    const p = await planProject(world().ctx);
    expect(p.status).toBe("needs-input");
    expect(p.summary.join("\n")).toMatch(/example-a[\s\S]*example-b/);
    expect(p.next_command).toBe("admobctl setup project use <project-id> --yes");
  });

  it("checks and stores the chosen project", async () => {
    const w = world();
    const p = await planProject(w.ctx, "example-a");
    expect(p.status).toBe("planned");
    await applyProject(w.ctx, p);
    expect(w.profile().quotaProject).toBe("example-a");
  });
});

describe("apis", () => {
  it("needs a project first", async () => {
    const p = await planApis(world().ctx, ["read"]);
    expect(p).toMatchObject({ status: "needs-input", next_command: "admobctl setup project list" });
  });

  it("plans the disabled APIs and enables them, with an audit entry", async () => {
    const w = world({ quotaProject: "example-a" });
    const p = await planApis(w.ctx, ["read", "payments"]);
    expect(p.status).toBe("planned");
    expect(p.summary[0]).toContain("adsense.googleapis.com");
    expect(p.next_command).toBe("admobctl setup apis --features payments --yes");
    await applyApis(w.ctx, p);
    expect(w.calls.find((c) => c.method === "POST")!.body).toEqual({ serviceIds: ["adsense.googleapis.com"] });
    expect(readFileSync(join(w.dir, "audit.log"), "utf8")).toContain("Enable APIs");
  });

  it("is done when every API is on", async () => {
    expect((await planApis(world({ quotaProject: "example-a", adsense: "ENABLED" }).ctx, ["read", "payments"])).status).toBe("done");
  });
});

describe("runSetup", () => {
  it("without a terminal stops at the sign-in with the command to run in a terminal", async () => {
    const r = await runSetup(world({ scopes: "signed-out", isTTY: false }).ctx, { features: [], yes: true });
    expect(r.steps.map((s) => [s.step, s.status])).toEqual([["login", "needs-input"]]);
    expect(r.next_command).toBe("admobctl setup login --yes");
  });

  it("without --yes stops at the first change with its command", async () => {
    const r = await runSetup(world({ quotaProject: "example-a" }).ctx, { features: ["payments"], yes: false });
    expect(r.steps.map((s) => [s.step, s.status])).toEqual([["login", "planned"]]);
  });

  it("changes nothing without --yes, not even the stored features", async () => {
    const w = world({ scopes: [...READ_SCOPES, S("adsense.readonly")], quotaProject: "example-a" });
    await runSetup(w.ctx, { features: ["payments"], yes: false });
    expect(w.profile().features).toBeUndefined();
  });

  it("runs every step with --yes and finishes with no next command", async () => {
    const w = world({ scopes: [...READ_SCOPES, S("adsense.readonly")] });
    const r = await runSetup(w.ctx, { features: ["payments"], project: "example-a", yes: true });
    expect(r.steps.map((s) => [s.step, s.status])).toEqual([
      ["login", "done"],
      ["project", "applied"],
      ["apis", "applied"],
    ]);
    expect(r.next_command).toBeUndefined();
    expect(w.profile()).toMatchObject({ quotaProject: "example-a", features: ["read", "payments"] });
  });

  it("stops at the project choice", async () => {
    const r = await runSetup(world().ctx, { features: [], yes: true });
    expect(r.steps.map((s) => [s.step, s.status])).toEqual([
      ["login", "done"],
      ["project", "needs-input"],
    ]);
    expect(r.next_command).toBe("admobctl setup project use <project-id> --yes");
  });
});


describe("setup review regressions", () => {
  it("never starts OAuth browser login without a terminal", async () => {
    const w = world({ mode: "oauth", scopes: "signed-out", isTTY: false });
    const plan = await planLogin(w.ctx, ["payments"]);
    await expect(applyLogin(w.ctx, plan)).rejects.toMatchObject({ code: "USAGE" });
    expect(w.oauthLogins).toEqual([]);
    const r = await runSetup(w.ctx, { features: ["payments"], yes: true });
    expect(r.steps[0]!.status).toBe("needs-input");
    expect(r.next_command).toBe("admobctl setup login --features payments --yes");
    expect(w.oauthLogins).toEqual([]);
    expect(w.profile().features).toBeUndefined();
  });

  it("names cloud-platform when feature scopes are already granted", async () => {
    const w = world({ scopes: [S("admob.readonly")] });
    const plan = await planLogin(w.ctx, []);
    expect(plan.summary[0]).toContain("cloud-platform");
    expect(plan.summary.join("\n")).toContain("cloud.google.com/sdk/docs/install");
  });

  it("OAuth setup does not require a quota project", async () => {
    const w = world({ mode: "oauth" });
    const r = await runSetup(w.ctx, { features: ["read"], yes: false });
    expect(r.next_command).toBeUndefined();
    expect(r.steps.map((s) => s.status)).toEqual(["done", "done", "done"]);
    expect(w.calls).toEqual([]);
    expect(r.steps[2]!.summary.join(" ")).toContain("OAuth client");
    expect(w.profile().quotaProject).toBeUndefined();
  });

  it("invalidates the cached token before the next setup API call", async () => {
    const w = world({ scopes: "signed-out", quotaProject: "example-a" });
    let current = "old-token";
    let resets = 0;
    w.ctx.svc.tokenProvider.getToken = async () => current;
    w.ctx.svc.tokenProvider.resetCache = () => { current = "new-token"; resets++; };
    w.ctx.cloud = new CloudClient({ getToken: () => w.ctx.svc.tokenProvider.getToken(), fetch: fakeFetch({
      "GET /services/admob.googleapis.com": (c) => {
        expect(c.headers.authorization).toBe("Bearer new-token");
        return jsonResponse({ state: "ENABLED" });
      },
    }).fetch });
    await runSetup(w.ctx, { features: ["read"], yes: true });
    expect(resets).toBe(1);
  });

  it("targets an explicit API consumer without overwriting the quota project", async () => {
    const w = world({ quotaProject: "example-b" });
    const p = await planApis(w.ctx, ["payments"], "example-a");
    expect(p.project).toBe("example-a");
    expect(p.next_command).toBe("admobctl setup apis --features payments --project example-a --yes");
    await applyApis(w.ctx, p);
    expect(w.calls.find((c) => c.method === "POST")!.url).toContain("/projects/example-a/services:batchEnable");
    expect(w.profile().quotaProject).toBeUndefined();
  });
});

it("service-account override is surfaced before attempting browser sign-in", async () => {
  const w = world({ scopes: "signed-out" });
  w.ctx.svc.tokenProvider.checkCredentials = () => {
    throw new AdmobctlError("AUTH_SERVICE_ACCOUNT", "Unset GOOGLE_APPLICATION_CREDENTIALS in your terminal.", { fix: "Unset GOOGLE_APPLICATION_CREDENTIALS, then run admobctl setup login --yes." });
  };
  await expect(runSetup(w.ctx, { features: ["read"], yes: true })).rejects.toMatchObject({ code: "AUTH_SERVICE_ACCOUNT", message: expect.stringContaining("GOOGLE_APPLICATION_CREDENTIALS") });
  expect(w.execCalls).toEqual([]);
  expect(w.profile().features).toBeUndefined();
});

it("gcloud can replace unsupported default ADC when no environment override is active", async () => {
  const w = world({ scopes: "signed-out" });
  w.ctx.svc.tokenProvider.checkCredentials = () => {
    throw new AdmobctlError("AUTH_SERVICE_ACCOUNT", "Default ADC is not a user credential.", { fix: "admobctl setup login --yes" });
  };
  await applyLogin(w.ctx, await planLogin(w.ctx, ["read"]));
  expect(w.execCalls.at(-1)!.args.slice(0, 3)).toEqual(["auth", "application-default", "login"]);
});

it("a named-profile login plan keeps the selected identity in its next command", async () => {
  const w = world({ scopes: "signed-out" });
  const cfg = loadConfig(w.dir);
  cfg.profiles.work = {};
  saveConfig(w.dir, cfg);
  w.ctx.svc = AdmobService.create({ profile: "work" }, { configDir: w.dir, tokenProvider: w.ctx.svc.tokenProvider });
  const p = await planLogin(w.ctx, ["payments"]);
  expect(p.next_command).toBe("admobctl --profile work setup login --features payments --yes");
});

it("explicit default profile is kept when the configured default is another profile", async () => {
  const w = world({ scopes: "signed-out" });
  const cfg = loadConfig(w.dir);
  cfg.profiles.work = {};
  cfg.defaultProfile = "work";
  saveConfig(w.dir, cfg);
  const p = await planLogin(w.ctx, ["read"]);
  expect(p.next_command).toBe("admobctl --profile default setup login --yes");
});

it("manual OAuth hints also keep the named profile", async () => {
  const w = world({ mode: "oauth", scopes: "signed-out" });
  const cfg = loadConfig(w.dir);
  cfg.profiles.work = {};
  saveConfig(w.dir, cfg);
  w.ctx.svc = AdmobService.create({ profile: "work" }, { configDir: w.dir, tokenProvider: w.ctx.svc.tokenProvider });
  const login = await planLogin(w.ctx, ["payments"]);
  expect(login.summary.join(" ")).toContain("admobctl --profile work auth login --payments --cloud-platform");
  const apis = await planApis(w.ctx, ["read"]);
  expect(apis.summary.join(" ")).toContain("admobctl --profile work setup status");
  expect(apis.summary.join(" ")).toContain("admobctl --profile work setup apis --project");
});

describe("credentials selected by GOOGLE_APPLICATION_CREDENTIALS", () => {
  const UNSET = "Unset GOOGLE_APPLICATION_CREDENTIALS in the terminal that runs admobctl, then run admobctl setup login --yes.";

  it("refuses a gcloud sign-in that would write a file admobctl does not read", async () => {
    const w = world({ scopes: [S("admob.readonly")] });
    w.ctx.svc.tokenProvider.signInBlocked = () => UNSET;
    await expect(planLogin(w.ctx, ["read"])).rejects.toMatchObject({ code: "AUTH_SCOPE_MISSING", message: expect.stringContaining("GOOGLE_APPLICATION_CREDENTIALS"), fix: UNSET });
    await expect(runSetup(w.ctx, { features: ["read"], yes: true })).rejects.toMatchObject({ fix: UNSET });
    expect(w.execCalls).toEqual([]);
    expect(w.profile().features).toBeUndefined();
  });

  it("passes on the manual fix for a missing credentials file", async () => {
    const w = world({ scopes: "signed-out" });
    w.ctx.svc.tokenProvider.checkCredentials = () => {
      throw new AdmobctlError("AUTH_NO_CREDENTIALS", "GOOGLE_APPLICATION_CREDENTIALS points at /synthetic/missing.json, which cannot be read.", { fix: UNSET });
    };
    await expect(planLogin(w.ctx, ["read"])).rejects.toMatchObject({ code: "AUTH_NO_CREDENTIALS", fix: UNSET });
  });

  it("is still done when the selected credentials have every scope", async () => {
    const w = world();
    w.ctx.svc.tokenProvider.signInBlocked = () => UNSET;
    expect((await planLogin(w.ctx, ["read"])).status).toBe("done");
  });
});
