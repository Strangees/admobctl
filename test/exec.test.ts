import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { exec, spawnTarget } from "../src/core/exec.js";

// The real exec, in a child Node process, so its stdout and stderr can be told apart.
const execModule = new URL("../src/core/exec.ts", import.meta.url).href;

it("an interactive child writes its stdout to stderr, so admobctl's stdout keeps only command output", () => {
  const script = `const { exec } = await import(${JSON.stringify(execModule)});
await exec(process.execPath, ["-e", "process.stdout.write('child-out')"], { interactive: true });`;
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  expect(r.status, r.stderr).toBe(0);
  expect(r.stdout).toBe("");
  expect(r.stderr).toContain("child-out");
});

describe("exec", () => {
  it("returns as soon as a background program has started, without waiting for it", async () => {
    const started = Date.now();
    const r = await exec(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { background: true });
    expect(r.code).toBe(0);
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it("rejects when a background program cannot be started", async () => {
    await expect(exec("admobctl-no-such-program", [], { background: true })).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("gives a child without input no stdin pipe", async () => {
    const r = await exec(process.execPath, ["-e", "process.stdout.write(String(require('node:fs').fstatSync(0).isFIFO()))"]);
    expect(r).toMatchObject({ code: 0, stdout: "false" });
  });

  it("still passes input on stdin", async () => {
    const r = await exec(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { input: "hello" });
    expect(r).toMatchObject({ code: 0, stdout: "hello" });
  });

  it("reports the exit code of a child that exits before reading its input, instead of crashing on EPIPE", async () => {
    const r = await exec(process.execPath, ["-e", "process.exit(3)"], { input: "x".repeat(8 * 1024 * 1024) });
    expect(r.code).toBe(3);
  });
});

describe("spawnTarget", () => {
  const env = { Path: 'C:\\Windows\\system32;"C:\\Cloud SDK (x86)\\bin"', PATHEXT: ".COM;.EXE;.BAT;.CMD", ComSpec: "C:\\Windows\\system32\\cmd.exe" };
  const files = (...paths: string[]) => (p: string) => paths.includes(p);
  const gcloudCmd = files("C:\\Cloud SDK (x86)\\bin\\gcloud.CMD");

  it("spawns programs directly outside Windows", () => {
    expect(spawnTarget("gcloud", ["--version"], { platform: "linux", env, isFile: () => true })).toEqual({ file: "gcloud", args: ["--version"] });
  });

  it("spawns a Windows .exe directly", () => {
    const args = ["url.dll,FileProtocolHandler", "https://example.com/?a=1&b=2"];
    expect(spawnTarget("rundll32", args, { platform: "win32", env, isFile: files("C:\\Windows\\system32\\rundll32.EXE") })).toEqual({ file: "rundll32", args });
  });

  it("runs a Windows batch program (gcloud.cmd) through cmd.exe, by its full location on PATH", () => {
    const scopes = "--scopes=https://www.googleapis.com/auth/admob.readonly,https://www.googleapis.com/auth/cloud-platform";
    const t = spawnTarget("gcloud", ["auth", "application-default", "login", scopes], { platform: "win32", env, isFile: gcloudCmd });
    expect(t.file).toBe("C:\\Windows\\system32\\cmd.exe");
    expect(t.windowsVerbatimArguments).toBe(true);
    expect(t.args).toEqual([
      "/d",
      "/s",
      "/c",
      '""C:\\Cloud SDK (x86)\\bin\\gcloud.CMD" ^^^"auth^^^" ^^^"application-default^^^" ^^^"login^^^" ' +
        '^^^"--scopes=https://www.googleapis.com/auth/admob.readonly^^^,https://www.googleapis.com/auth/cloud-platform^^^""',
    ]);
  });

  it("quotes and escapes every batch argument, so cmd.exe cannot read any of it as a command", () => {
    const t = spawnTarget("gcloud", ['a "b" & calc', "c:\\dir\\", "x|y<z>(w)^"], { platform: "win32", env, isFile: gcloudCmd });
    expect(t.args[3]).toBe(
      '""C:\\Cloud SDK (x86)\\bin\\gcloud.CMD" ' +
        '^^^"a^^^ \\^^^"b\\^^^"^^^ ^^^&^^^ calc^^^" ' +
        '^^^"c:\\dir\\\\^^^" ' +
        '^^^"x^^^|y^^^<z^^^>^^^(w^^^)^^^^^^^""',
    );
  });

  it("refuses batch arguments that cmd.exe would expand or cut off", () => {
    for (const bad of ["%PATH%", "!x!", "a\nb", "a\rb", "a\0b"]) {
      expect(() => spawnTarget("gcloud", [bad], { platform: "win32", env, isFile: gcloudCmd })).toThrow(/cannot be passed safely/);
    }
  });

  it("reads PATH, PATHEXT and ComSpec in any case, with Windows' defaults", () => {
    const t = spawnTarget("gcloud", ["--version"], { platform: "win32", env: { PATH: "C:\\sdk\\bin" }, isFile: files("C:\\sdk\\bin\\gcloud.CMD") });
    expect(t).toEqual({ file: "cmd.exe", args: ["/d", "/s", "/c", '""C:\\sdk\\bin\\gcloud.CMD" ^^^"--version^^^""'], windowsVerbatimArguments: true });
  });
});
