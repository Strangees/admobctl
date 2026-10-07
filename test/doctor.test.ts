import { describe, expect, it } from "vitest";
import { fetchTokenInfo, runDoctor, type DoctorDeps } from "../src/core/auth/doctor.js";
import { AdmobctlError, CLOUD_PLATFORM_SCOPE } from "../src/core/errors.js";
import { fakeFetch, fixture, jsonResponse, noSleep } from "./helpers.js";

const okDeps = (): DoctorDeps => ({
  mode: "adc",
  checkCredentials: () => ({ path: "/adc.json", type: "authorized_user", quotaProjectId: "qp" }),
  getToken: async () => "tok",
  tokenInfo: async () => ({ scopes: ["https://www.googleapis.com/auth/admob.readonly"], expiresIn: 3000 }),
  quotaProject: "qp",
  listAccounts: async () => fixture<{ account: never[] }>("accounts.json").account,
  account: async () => fixture<{ account: Array<{ publisherId: string }> }>("accounts.json").account[0]! as never,
  listApps: async () => [
    { alias: "quiz-ios", appId: "a~1", name: "Quiz", platform: "IOS", resource: "accounts/p/apps/1", approval: "APPROVED" },
  ],
});

const byId = (checks: Awaited<ReturnType<typeof runDoctor>>) => Object.fromEntries(checks.map((c) => [c.id, c]));

describe("runDoctor", () => {
  it("passes every check on a healthy setup", async () => {
    const checks = await runDoctor(okDeps());
    expect(checks.map((c) => [c.id, c.status])).toEqual([
      ["credentials", "ok"],
      ["token", "ok"],
      ["scope", "ok"],
      ["quota-project", "ok"],
      ["api", "ok"],
      ["account", "ok"],
      ["apps", "ok"],
    ]);
  });

  it("stops early and gives the login fix when credentials are missing", async () => {
    const checks = byId(
      await runDoctor({
        ...okDeps(),
        checkCredentials: () => {
          throw new AdmobctlError("AUTH_NO_CREDENTIALS", "none", { fix: "gcloud auth application-default login" });
        },
      }),
    );
    expect(checks.credentials!.status).toBe("fail");
    expect(checks.credentials!.fix).toContain("gcloud auth application-default login");
    expect(checks.api!.status).toBe("skip");
  });

  it("flags a missing AdMob scope", async () => {
    const checks = byId(await runDoctor({ ...okDeps(), tokenInfo: async () => ({ scopes: ["openid"] }) }));
    expect(checks.scope!.status).toBe("fail");
    expect(checks.scope!.fix).toBe("admobctl setup login --yes");
  });

  it("warns when no quota project is set in ADC mode", async () => {
    const checks = byId(await runDoctor({ ...okDeps(), quotaProject: undefined }));
    expect(checks["quota-project"]!.status).toBe("warn");
    expect(checks["quota-project"]!.fix).toBe("admobctl setup project list");
  });

  it("reports a disabled API with its fix", async () => {
    const checks = byId(
      await runDoctor({
        ...okDeps(),
        listAccounts: async () => {
          throw new AdmobctlError("API_NOT_ENABLED", "disabled", { fix: "gcloud services enable admob.googleapis.com --project qp" });
        },
      }),
    );
    expect(checks.api!.status).toBe("fail");
    expect(checks.api!.fix).toBe("gcloud services enable admob.googleapis.com --project qp");
    expect(checks.account!.status).toBe("skip");
  });

  it("warns about apps that need action in AdMob", async () => {
    const checks = byId(
      await runDoctor({
        ...okDeps(),
        listApps: async () => [
          { alias: "quiz-ios", appId: "a~1", name: "Quiz", platform: "IOS", resource: "r1", approval: "APPROVED" },
          { alias: "timer-android", appId: "a~2", name: "Timer", platform: "ANDROID", resource: "r2", approval: "ACTION_REQUIRED" },
          { alias: "draw-ios", appId: "a~3", name: "Draw", platform: "IOS", resource: "r3", approval: "IN_REVIEW" },
        ],
      }),
    );
    expect(checks.apps!.status).toBe("warn");
    expect(checks.apps!.summary).toMatch(/timer-android/);
    expect(checks.apps!.summary).toMatch(/1 in review/);
    expect(checks.apps!.fix).toMatch(/AdMob/);
  });

  it("reports which v1beta methods this account can reach, as a warning only", async () => {
    const denied = new AdmobctlError("BETA_ACCESS_DENIED", "Permission denied for mediationGroups.list (AdMob API v1beta).", { fix: "ask your account manager" });
    const checks = byId(
      await runDoctor({
        ...okDeps(),
        betaProbes: { "ad sources": async () => [], "mediation groups": async () => Promise.reject(denied) },
      }),
    );
    expect(checks.beta!.status).toBe("warn");
    expect(checks.beta!.summary).toMatch(/ad sources: ok; mediation groups: no access/);
    expect(checks.beta!.fix).toBe("ask your account manager");
  });

  it("says when write commands are enabled by the monetization scope", async () => {
    const checks = byId(
      await runDoctor({
        ...okDeps(),
        tokenInfo: async () => ({ scopes: ["https://www.googleapis.com/auth/admob.readonly", "https://www.googleapis.com/auth/admob.monetization"] }),
      }),
    );
    expect(checks.scope!.status).toBe("ok");
    expect(checks.scope!.summary).toMatch(/admob\.monetization \(write commands enabled\)/);
  });

  it("says when finance balance is enabled by the adsense scope", async () => {
    const checks = byId(
      await runDoctor({
        ...okDeps(),
        tokenInfo: async () => ({ scopes: ["https://www.googleapis.com/auth/admob.readonly", "https://www.googleapis.com/auth/adsense.readonly"] }),
      }),
    );
    expect(checks.scope!.status).toBe("ok");
    expect(checks.scope!.summary).toMatch(/adsense\.readonly \(finance balance enabled\)/);
  });
});

describe("runDoctor setup checks", () => {
  const READ = "https://www.googleapis.com/auth/admob.readonly";
  const ADSENSE = "https://www.googleapis.com/auth/adsense.readonly";

  it("warns when a stored feature's scope is missing, with a login fix that keeps all features", async () => {
    const checks = byId(await runDoctor({ ...okDeps(), features: ["read", "write", "payments"], tokenInfo: async () => ({ scopes: [READ] }) }));
    expect(checks.features!.status).toBe("warn");
    expect(checks.features!.summary).toMatch(/write, payments/);
    expect(checks.features!.fix).toBe("admobctl setup login --features write,payments --yes");
    expect(checks.features!.fix_command).toBe("admobctl setup login --features write,payments --yes");
  });

  it("is ok when every stored feature's scope is granted", async () => {
    const checks = byId(await runDoctor({ ...okDeps(), features: ["read", "payments"], tokenInfo: async () => ({ scopes: [READ, ADSENSE, CLOUD_PLATFORM_SCOPE] }) }));
    expect(checks.features!.status).toBe("ok");
  });

  it("warns when setup's cloud-platform scope is missing even when feature scopes are granted", async () => {
    const checks = byId(await runDoctor({ ...okDeps(), mode: "oauth", features: ["read", "payments"], tokenInfo: async () => ({ scopes: [READ, ADSENSE] }) }));
    expect(checks.features!.status).toBe("warn");
    expect(checks.features!.summary).toMatch(/cloud-platform/);
    expect(checks.features!.fix).toBe("admobctl setup login --features payments --yes");
  });

  it("does not claim OAuth client APIs are enabled when Service Usage state is unavailable", async () => {
    const checks = byId(await runDoctor({ ...okDeps(), mode: "oauth", features: ["read", "payments"] }));
    expect(checks.apis!.status).toBe("skip");
    expect(checks.apis!.summary).toMatch(/actual feature API requests/);
  });

  it("preserves the service-account prerequisite without exposing a repeatable fix command", async () => {
    const fix = "Unset GOOGLE_APPLICATION_CREDENTIALS in the terminal that runs admobctl, then run admobctl setup login --yes.";
    const checks = byId(
      await runDoctor({
        ...okDeps(),
        checkCredentials: () => {
          throw new AdmobctlError("AUTH_SERVICE_ACCOUNT", "AdMob does not support service accounts.", { fix });
        },
      }),
    );
    expect(checks.credentials!.fix).toBe(fix);
    expect(checks.credentials!.fix_command).toBeUndefined();
  });

  it("gives the manual step instead of setup login when a sign-in cannot replace the credentials in use", async () => {
    const UNSET = "Unset GOOGLE_APPLICATION_CREDENTIALS in the terminal that runs admobctl, then run admobctl setup login --yes.";
    const checks = byId(
      await runDoctor({
        ...okDeps(),
        signInBlocked: UNSET,
        features: ["read", "payments"],
        tokenInfo: async () => ({ scopes: ["openid"] }),
        listAccounts: async () => Promise.reject(new AdmobctlError("AUTH_SCOPE_MISSING", "no AdMob scope", { fix: "admobctl setup login --yes" })),
      }),
    );
    for (const id of ["scope", "features", "api"] as const) {
      expect(checks[id]!.fix, id).toBe(UNSET);
      expect(checks[id]!.fix_command, id).toBeUndefined();
    }
  });

  it("fails when a needed API is disabled, with the setup apis fix", async () => {
    const checks = byId(
      await runDoctor({
        ...okDeps(),
        features: ["read", "payments"],
        serviceStates: async () => ({ "admob.googleapis.com": "ENABLED", "adsense.googleapis.com": "DISABLED" }),
      }),
    );
    expect(checks.apis!.status).toBe("fail");
    expect(checks.apis!.summary).toMatch(/adsense\.googleapis\.com/);
    expect(checks.apis!.fix_command).toBe("admobctl setup apis --features payments --yes");
  });

  it("never turns a fix with a <placeholder> into a fix_command", async () => {
    const checks = byId(
      await runDoctor({ ...okDeps(), account: async () => Promise.reject(new AdmobctlError("USAGE", "pick one", { fix: "admobctl config set account <pub-id>" })) }),
    );
    expect(checks.account!.fix).toBe("admobctl config set account <pub-id>");
    expect(checks.account!.fix_command).toBeUndefined();
  });

  it("only sets fix_command for admobctl commands", async () => {
    const checks = await runDoctor({ ...okDeps(), quotaProject: undefined, listApps: async () => [{ alias: "a", appId: "a~1", name: "A", platform: "IOS", resource: "r", approval: "ACTION_REQUIRED" }] as never });
    const byIdx = byId(checks);
    expect(byIdx["quota-project"]!.fix_command).toBe("admobctl setup project list");
    expect(byIdx.apps!.fix).toBeTruthy();
    expect(byIdx.apps!.fix_command).toBeUndefined();
  });
});

describe("fetchTokenInfo", () => {
  const READ = "https://www.googleapis.com/auth/admob.readonly";

  it("retries a transient 5xx", async () => {
    const f = fakeFetch({ "POST /tokeninfo": () => (f.calls.length === 1 ? jsonResponse({}, 503) : jsonResponse({ scope: READ, expires_in: "3000" })) });
    expect(await fetchTokenInfo("t", f.fetch, noSleep)).toEqual({ scopes: [READ], expiresIn: 3000 });
    expect(f.calls).toHaveLength(2);
  });

  it("reports a tokeninfo outage as such, not as a rejected token", async () => {
    const f = fakeFetch({ "POST /tokeninfo": () => jsonResponse({}, 500) });
    const err = await fetchTokenInfo("t", f.fetch, noSleep).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "API_ERROR", status: 500 });
    expect((err as Error).message).not.toMatch(/rejected/);
  });

  it("is a rejected token only on 400/401", async () => {
    for (const status of [400, 401]) {
      const f = fakeFetch({ "POST /tokeninfo": () => jsonResponse({ error_description: "Invalid Value" }, status) });
      await expect(fetchTokenInfo("t", f.fetch, noSleep)).rejects.toMatchObject({ code: "AUTH_TOKEN_EXPIRED", fix: "admobctl setup login --yes" });
    }
  });

  it("turns a network failure into an AdmobctlError", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(fetchTokenInfo("t", down, noSleep)).rejects.toBeInstanceOf(AdmobctlError);
  });
});
