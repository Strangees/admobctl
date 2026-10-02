// Writes the MCP tools/list output of the built bundle (no credentials needed) for eval mocks.
import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/admobctl.mjs", "mcp"], stderr: "ignore" });
const client = new Client({ name: "dump-tools", version: "0" });
await client.connect(transport);
const result = await client.listTools();
writeFileSync(process.argv[2] ?? "evals/mocks/admobctl/_tools.json", `${JSON.stringify(result, null, 2)}\n`);
await client.close();
