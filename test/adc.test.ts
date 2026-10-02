import { describe, expect, it } from "vitest";
import { adcPath, AdcTokenProvider, readAdcInfo } from "../src/core/auth/adc.js";

describe("adcPath", () => {
  it("prefers GOOGLE_APPLICATION_CREDENTIALS", () => {
    expect(adcPath({ GOOGLE_APPLICATION_CREDENTIALS: "/k.json" }, "darwin", "/h")).toBe("/k.json");
  });
  it("honours CLOUDSDK_CONFIG", () => {
    expect(adcPath({ CLOUDSDK_CONFIG: "/gc" }, "linux", "/h")).toBe("/gc/application_default_credentials.json");
  });
  it("uses the gcloud default locations", () => {
    expect(adcPath({}, "darwin", "/h")).toBe("/h/.config/gcloud/application_default_credentials.json");
    expect(adcPath({ APPDATA: "C:\\AD" }, "win32", "C:\\h")).toMatch(/gcloud.application_default_credentials\.json$/);
  });
});

describe("readAdcInfo", () => {
  it("returns only non-secret fields", () => {
    const info = readAdcInfo("/f", () =>
      JSON.stringify({ type: "authorized_user", quota_project_id: "qp", client_id: "cid", client_secret: "S", refresh_token: "R" }),
    );
    expect(info).toEqual({ path: "/f", type: "authorized_user", quotaProjectId: "qp" });
    expect(JSON.stringify(info)).not.toContain("R");
  });

  it("returns undefined when the file is missing", () => {
    expect(
      readAdcInfo("/missing", () => {
        throw Object.assign(new Error("nope"), { code: "ENOENT" });
      }),
    ).toBeUndefined();
  });
});

describe("AdcTokenProvider", () => {
  const authorizedUser = () => ({ path: "/f", type: "authorized_user", quotaProjectId: "qp" });

  it("runs gcloud and caches the token", async () => {
    let runs = 0;
    const p = new AdcTokenProvider({
      info: authorizedUser,
      exec: async (cmd, args) => {
        runs++;
        expect(cmd).toBe("gcloud");
        expect(args).toEqual(["auth", "application-default", "print-access-token"]);
        return { code: 0, stdout: "ya29.token\n", stderr: "" };
      },
    });
    expect(await p.getToken()).toBe("ya29.token");
    expect(await p.getToken()).toBe("ya29.token");
    expect(runs).toBe(1);
  });

  it("points gcloud at the same credentials file we inspected", async () => {
    let env: NodeJS.ProcessEnv | undefined;
    const p = new AdcTokenProvider({
      info: () => ({ path: "/inspected/adc.json", type: "authorized_user", quotaProjectId: "qp" }),
      exec: async (_cmd, _args, opts) => {
        env = opts?.env;
        return { code: 0, stdout: "ya29.token\n", stderr: "" };
      },
    });
    await p.getToken();
    expect(env?.GOOGLE_APPLICATION_CREDENTIALS).toBe("/inspected/adc.json");
    expect(env?.PATH).toBe(process.env.PATH);
  });

  it("refuses service-account credentials", async () => {
    const p = new AdcTokenProvider({
      info: () => ({ path: "/f", type: "service_account" }),
      exec: async () => ({ code: 0, stdout: "x", stderr: "" }),
    });
    await expect(p.getToken()).rejects.toMatchObject({ code: "AUTH_SERVICE_ACCOUNT" });
  });

  it("explains how to log in when ADC is missing", async () => {
    const p = new AdcTokenProvider({ info: () => undefined, exec: async () => ({ code: 0, stdout: "", stderr: "" }) });
    const err = await p.getToken().catch((e) => e);
    expect(err.code).toBe("AUTH_NO_CREDENTIALS");
    expect(err.fix).toContain("gcloud auth application-default login");
  });

  it("maps a gcloud reauth failure to AUTH_TOKEN_EXPIRED", async () => {
    const p = new AdcTokenProvider({
      info: authorizedUser,
      exec: async () => ({ code: 1, stdout: "", stderr: "ERROR: (gcloud.auth.application-default.print-access-token) There was a problem refreshing your current auth tokens: Reauthentication failed. invalid_grant" }),
    });
    await expect(p.getToken()).rejects.toMatchObject({ code: "AUTH_TOKEN_EXPIRED" });
  });

  it("reports a missing gcloud binary", async () => {
    const p = new AdcTokenProvider({
      info: authorizedUser,
      exec: async () => {
        throw Object.assign(new Error("spawn gcloud ENOENT"), { code: "ENOENT" });
      },
    });
    await expect(p.getToken()).rejects.toMatchObject({ code: "AUTH_NO_CREDENTIALS" });
  });
});
