//#region src/core/log.ts
/**
* All diagnostics go to stderr. stdout is reserved for command output
* (and for the MCP protocol when running `admobctl mcp`).
*/
let verbose = Boolean(process.env.ADMOBCTL_DEBUG);
const log = {
	setVerbose(v) {
		verbose = v;
	},
	debug(msg) {
		if (verbose) process.stderr.write(`[admobctl] ${msg}\n`);
	},
	warn(msg) {
		process.stderr.write(`warning: ${msg}\n`);
	}
};

//#endregion
export { log };