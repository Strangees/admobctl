/** End-to-end checks against the built plugin/dist (npm run build first). */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

const dist = fileURLToPath(new URL("../plugin/dist", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "admobctl-e2e-"));
const env = { ...process.env, ADMOBCTL_HOME: home } as Record<string, string>;
// Run a copy outside the repo, as an installed plugin does: every module must come from dist itself, not node_modules.
const bin = join(home, "plugin", "dist", "admobctl.mjs");
if (existsSync(dist)) cpSync(dist, join(home, "plugin", "dist"), { recursive: true });

describe.skipIf(!existsSync(dist))("built plugin/dist", () => {
  it("runs from any working directory", () => {
    const out = execFileSync(process.execPath, [bin, "--version"], { env, cwd: tmpdir(), encoding: "utf8" });
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("prints help without touching the network", () => {
    const out = execFileSync(process.execPath, [bin, "--help"], { env, encoding: "utf8" });
    expect(out).toContain("finance");
    expect(out).toContain("mcp");
  });

  it("serves MCP over stdio with nothing but protocol on stdout", async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [bin, "mcp"], env, stderr: "pipe" });
    const client = new Client({ name: "e2e", version: "0" });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.length).toBe(25);
    await client.close();
  }, 20_000);
});
