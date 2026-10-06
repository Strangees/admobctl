import { run } from "./cli/program.js";
import { runStdioServer } from "./mcp/server.js";

const code = await run(process.argv, {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  isTTY: Boolean(process.stdout.isTTY),
  stdinIsTTY: Boolean(process.stdin.isTTY),
  runMcp: runStdioServer,
});
process.exitCode = code;
