import { run } from "./cli/program.js";

const code = await run(process.argv, {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  isTTY: Boolean(process.stdout.isTTY),
});
process.exitCode = code;
