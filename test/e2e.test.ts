/** End-to-end checks against the built single-file bundle (npm run build first). */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

const bin = fileURLToPath(new URL("../dist/admobctl.mjs", import.meta.url));
const env = { ...process.env, ADMOBCTL_HOME: mkdtempSync(join(tmpdir(), "admobctl-e2e-")) } as Record<string, string>;

describe.skipIf(!existsSync(bin))("built bundle", () => {
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
    expect(tools.length).toBe(18);
    await client.close();
  }, 20_000);
});
