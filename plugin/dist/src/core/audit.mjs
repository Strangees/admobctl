import { AdmobctlError } from "./errors.mjs";
import { ensurePrivateDir } from "./fs.mjs";
import { appendFileSync, chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";

//#region src/core/audit.ts
/** Append one JSON line per applied write to <configDir>/audit.log (0600). */
function appendAudit(dir, entry) {
	ensurePrivateDir(dir);
	const file = join(dir, "audit.log");
	appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 384 });
	chmodSync(file, 384);
}
/** Read <configDir>/audit.log back, newest first. A missing log is an empty one. */
function readAudit(dir, opts = {}) {
	const file = join(dir, "audit.log");
	let text = "";
	try {
		text = readFileSync(file, "utf8");
	} catch (err) {
		if (err.code !== "ENOENT") throw new AdmobctlError("CONFIG", `Could not read ${file}: ${err.message}`, {
			fix: `ls -l ${file}  # it must be a file you can read; move it aside to start a new log`,
			cause: err
		});
	}
	let skipped = 0;
	let entries = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const e = JSON.parse(line);
			if (typeof e?.time !== "string" || typeof e.action !== "string" || typeof e.method !== "string" || typeof e.path !== "string") throw new Error("not an entry");
			entries.push(e);
		} catch {
			skipped++;
		}
	}
	entries.reverse();
	if (opts.failed) entries = entries.filter((e) => !e.ok);
	if (opts.last !== void 0) entries = entries.slice(0, opts.last);
	return {
		file,
		entries,
		skipped
	};
}

//#endregion
export { appendAudit, readAudit };