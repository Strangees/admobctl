// Runs the built bundle on this Node version: --version, then --help for every command and subcommand.
// CI runs it on Node 20 too, where vitest cannot run.
import { execFileSync } from "node:child_process";

/** @param {string[]} args */
const run = (args) =>
  execFileSync(process.execPath, ["plugin/dist/admobctl.mjs", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

console.log(`admobctl ${run(["--version"]).trim()} on Node ${process.versions.node}`);

let commands = 0;
/** @param {string[]} path */
function walk(path) {
  const help = run([...path, "--help"]);
  commands++;
  // Command names start the lines of the Commands: section after two spaces; wrapped descriptions are indented further.
  const section = help.split(/^Commands:\n/m)[1] ?? "";
  for (const [, name] of section.matchAll(/^ {2}([a-z][\w-]*)/gm)) if (name && name !== "help") walk([...path, name]);
}
walk([]);
if (commands < 10) throw new Error(`--help listed only ${commands - 1} commands; did the help format change?`);
console.log(`--help ran for ${commands} commands`);
