/** End-to-end checks against the built single-file bundle (npm run build first). */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

const bin = fileURLToPath(new URL("../plugin/dist/admobctl.mjs", import.meta.url));
const env = { ...process.env, ADMOBCTL_HOME: mkdtempSync(join(tmpdir(), "admobctl-e2e-")) } as Record<string, string>;

describe.skipIf(!existsSync(bin))("built bundle", () => {
  it("prints help without touching the network", () => {
    const out = execFileSync(process.execPath, [bin, "--help"], { env, encoding: "utf8" });
    expect(out).toContain("finance");
    expect(out).toContain("mcp");
  });

  it("exits quietly when the reader closes the pipe early (| head)", async () => {
    const home = mkdtempSync(join(tmpdir(), "admobctl-e2e-"));
    const entry = { time: "2026-10-01T10:00:00.000Z", profile: "default", action: "Create app", method: "POST", path: "accounts/pub-0000000000000001/apps", body: {}, ok: true };
    // Far more than a pipe buffer, so output is still pending when the reader goes away.
    writeFileSync(join(home, "audit.log"), `${JSON.stringify(entry)}\n`.repeat(5000));
    const child = spawn(process.execPath, [bin, "audit-log", "-o", "json"], { env: { ...env, ADMOBCTL_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d));
    child.stdout.once("data", () => child.stdout.destroy());
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(stderr).toBe("");
    expect(code).toBe(0);
  }, 20_000);

  it("serves MCP over stdio with nothing but protocol on stdout", async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [bin, "mcp"], env, stderr: "pipe" });
    const client = new Client({ name: "e2e", version: "0" });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.length).toBe(25);
    await client.close();
  }, 20_000);
});
