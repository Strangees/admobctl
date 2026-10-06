/**
 * Setup errors provide a runnable command except for service-account credentials, which require clearing an environment override first.
 */
import { describe, expect, it } from "vitest";
import { AdcTokenProvider } from "../src/core/auth/adc.js";
import { fetchTokenInfo } from "../src/core/auth/doctor.js";
import { AdmobClient } from "../src/core/client.js";
import { AdmobctlError, diagnoseApiError } from "../src/core/errors.js";
import { jsonResponse, noSleep } from "./helpers.js";

const info = (reason: string, metadata: Record<string, string> = {}) => [
  { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, metadata },
];
async function rejection(p: Promise<unknown>): Promise<AdmobctlError> {
  const e = await p.then(() => undefined, (err: unknown) => err);
  expect(e).toBeInstanceOf(AdmobctlError);
  return e as AdmobctlError;
}

function client(status: number, body: unknown) {
  return new AdmobClient({ getToken: async () => "t", fetch: (async () => jsonResponse(body, status)) as typeof fetch, sleep: noSleep });
}

describe("setup fix commands", () => {
  const scopeBody = { error: { code: 403, message: "Request had insufficient authentication scopes.", details: info("ACCESS_TOKEN_SCOPE_INSUFFICIENT") } };

  it.each([
    ["quota project", 403, { error: { code: 403, message: "The admob.googleapis.com API requires a quota project, which is not set by default." } }, "admobctl setup project list"],
    ["AdMob API disabled", 403, { error: { code: 403, message: "AdMob API has not been used in project p", details: info("SERVICE_DISABLED", { consumer: "projects/p", service: "admob.googleapis.com" }) } }, "admobctl setup apis --project p --yes"],
    ["AdSense API disabled", 403, { error: { code: 403, message: "x", details: info("SERVICE_DISABLED", { consumer: "projects/p", service: "adsense.googleapis.com" }) } }, "admobctl setup apis --features payments --project p --yes"],
    ["scope missing", 403, scopeBody, "admobctl setup login --yes"],
    ["expired", 401, { error: { code: 401, message: "Request had invalid authentication credentials." } }, "admobctl setup login --yes"],
  ])("diagnoseApiError: %s", (_name, status, body, fix) => {
    expect(diagnoseApiError(status, body).fix).toBe(fix);
  });

  it("write and payments scope errors ask for that feature", async () => {
    expect((await rejection(client(403, scopeBody).write("POST", "accounts/pub-1/apps", {}))).fix).toBe("admobctl setup login --features write --yes");
    expect((await rejection(client(403, scopeBody).listPayments("pub-1"))).fix).toBe("admobctl setup login --features payments --yes");
  });

  it("ADC failures point at setup login", async () => {
    const none = new AdcTokenProvider({ info: () => undefined });
    expect(() => none.checkCredentials()).toThrow(AdmobctlError);
    try {
      none.checkCredentials();
    } catch (e) {
      expect((e as AdmobctlError).fix).toBe("admobctl setup login --yes");
    }
    const noGcloud = new AdcTokenProvider({ info: () => ({ path: "/x", type: "authorized_user" }), exec: async () => Promise.reject(new Error("ENOENT")) });
    expect((await rejection(noGcloud.getToken())).fix).toBe("admobctl setup login --yes");
    const expired = new AdcTokenProvider({ info: () => ({ path: "/x", type: "authorized_user" }), exec: async () => ({ code: 1, stdout: "", stderr: "Reauthentication required" }) });
    expect((await rejection(expired.getToken())).fix).toBe("admobctl setup login --yes");
    const broken = new AdcTokenProvider({ info: () => ({ path: "/x", type: "authorized_user" }), exec: async () => ({ code: 1, stdout: "", stderr: "boom" }) });
    expect((await rejection(broken.getToken())).fix).toBe("admobctl setup login --yes");
  });

  it("requires clearing GOOGLE_APPLICATION_CREDENTIALS before service-account recovery", async () => {
    const sa = new AdcTokenProvider({
      info: () => ({ path: "/synthetic/service-account.json", type: "service_account" }),
      env: { GOOGLE_APPLICATION_CREDENTIALS: "/synthetic/service-account.json" },
    });
    const serviceAccount = await rejection(sa.getToken());
    expect(serviceAccount.code).toBe("AUTH_SERVICE_ACCOUNT");
    expect(serviceAccount.fix).toBe("Unset GOOGLE_APPLICATION_CREDENTIALS in the terminal that runs admobctl, then run admobctl setup login --yes.");
  });

  it("lets setup replace a service account in the default ADC file", async () => {
    const sa = new AdcTokenProvider({ info: () => ({ path: "/synthetic/default-adc.json", type: "service_account" }), env: {} });
    const serviceAccount = await rejection(sa.getToken());
    expect(serviceAccount.code).toBe("AUTH_SERVICE_ACCOUNT");
    expect(serviceAccount.fix).toBe("admobctl setup login --yes");
  });

  it("a rejected token from tokeninfo points at setup login", async () => {
    const e = await rejection(fetchTokenInfo("t", (async () => new Response("", { status: 400 })) as typeof fetch));
    expect(e.fix).toBe("admobctl setup login --yes");
  });
});
