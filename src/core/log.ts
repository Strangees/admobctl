/**
 * All diagnostics go to stderr. stdout is reserved for command output
 * (and for the MCP protocol when running `admobctl mcp`).
 */
let verbose = Boolean(process.env.ADMOBCTL_DEBUG);

export const log = {
  setVerbose(v: boolean) {
    verbose = v;
  },
  debug(msg: string) {
    if (verbose) process.stderr.write(`[admobctl] ${msg}\n`);
  },
  warn(msg: string) {
    process.stderr.write(`warning: ${msg}\n`);
  },
};
