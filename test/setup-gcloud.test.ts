import { describe, expect, it } from "vitest";
import type { Exec } from "../src/core/exec.js";
import { gcloudInstalled, loginArgs, loginCommand, runLogin } from "../src/core/setup/gcloud.js";

const scopes = ["https://www.googleapis.com/auth/admob.readonly", "https://www.googleapis.com/auth/cloud-platform"];

function recorder(result: { code: number } | Error) {
  const calls: Array<{ cmd: string; args: string[]; opts?: Parameters<Exec>[2] }> = [];
  const exec: Exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (result instanceof Error) throw result;
    return { code: result.code, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

describe("gcloud handoff", () => {
  it("builds the ADC login command with the scopes", () => {
    expect(loginArgs(scopes)).toEqual(["auth", "application-default", "login", `--scopes=${scopes.join(",")}`]);
    expect(loginCommand(scopes)).toBe(`gcloud auth application-default login --scopes=${scopes.join(",")}`);
  });

  it("detects whether gcloud is installed", async () => {
    expect(await gcloudInstalled(recorder({ code: 0 }).exec)).toBe(true);
    expect(await gcloudInstalled(recorder({ code: 1 }).exec)).toBe(false);
    expect(await gcloudInstalled(recorder(new Error("ENOENT")).exec)).toBe(false);
  });

  it("runs the login interactively so gcloud can open the browser", async () => {
    const r = recorder({ code: 0 });
    await runLogin(r.exec, scopes);
    expect(r.calls[0]).toMatchObject({ cmd: "gcloud", args: loginArgs(scopes), opts: { interactive: true } });
  });

  it("fails with a setup login fix when the sign-in does not complete", async () => {
    await expect(runLogin(recorder({ code: 1 }).exec, scopes)).rejects.toMatchObject({
      code: "AUTH_NO_CREDENTIALS",
      fix: "admobctl setup login --yes",
    });
  });
});
