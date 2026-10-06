import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

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
