#!/usr/bin/env node
import { run } from "./src/cli/program.mjs";
import { runStdioServer } from "./src/mcp/server.mjs";

//#region src/bin.ts
const code = await run(process.argv, {
	stdout: (s) => process.stdout.write(s),
	stderr: (s) => process.stderr.write(s),
	isTTY: Boolean(process.stdout.isTTY),
	stdinIsTTY: Boolean(process.stdin.isTTY),
	runMcp: runStdioServer
});
process.exitCode = code;

//#endregion
export {  };