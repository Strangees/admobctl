import { describe, expect, it } from "vitest";
import { runDoctor, type DoctorDeps } from "../src/core/auth/doctor.js";
import { AdmobctlError } from "../src/core/errors.js";
import { fixture } from "./helpers.js";

const okDeps = (): DoctorDeps => ({
  mode: "adc",
  checkCredentials: () => ({ path: "/adc.json", type: "authorized_user", quotaProjectId: "qp" }),
  getToken: async () => "tok",
  tokenInfo: async () => ({ scopes: ["https://www.googleapis.com/auth/admob.readonly"], expiresIn: 3000 }),
  quotaProject: "qp",
  listAccounts: async () => fixture<{ account: never[] }>("accounts.json").account,
  account: async () => fixture<{ account: Array<{ publisherId: string }> }>("accounts.json").account[0]! as never,
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
    expect(checks.scope!.fix).toContain("admob.readonly");
  });

  it("warns when no quota project is set in ADC mode", async () => {
    const checks = byId(await runDoctor({ ...okDeps(), quotaProject: undefined }));
    expect(checks["quota-project"]!.status).toBe("warn");
    expect(checks["quota-project"]!.fix).toContain("set-quota-project");
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
});
