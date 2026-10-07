import { run } from "./cli/program.js";
import { runStdioServer } from "./mcp/server.js";

// A reader that stops early (`admobctl audit-log | head`) closes the pipe: end quietly with the exit code so far,
// not with an unhandled EPIPE error and a stack trace.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EPIPE") throw err;
    process.exit(process.exitCode);
  });
}

const code = await run(process.argv, {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  isTTY: Boolean(process.stdout.isTTY),
  stdinIsTTY: Boolean(process.stdin.isTTY),
  runMcp: runStdioServer,
});
process.exitCode = code;
