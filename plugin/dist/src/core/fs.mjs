import { log } from "./log.mjs";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { basename } from "node:path";

//#region src/core/fs.ts
/**
* Make sure `dir` exists and is private to the current user.
* - A dir we create is made 0700.
* - A pre-existing group/world-accessible dir is tightened to 0700 only when it is clearly
*   admobctl's own (basename `.admobctl`, which includes the default `~/.admobctl`) and owned by us.
*   Anything else (ADMOBCTL_HOME could be $HOME or /tmp) is left alone, with a warning naming the fix.
* - No-op on Windows / where POSIX uids are unavailable.
*/
function ensurePrivateDir(dir) {
	if (mkdirSync(dir, {
		recursive: true,
		mode: 448
	}) !== void 0) {
		chmodSync(dir, 448);
		return;
	}
	if (process.platform === "win32" || typeof process.getuid !== "function") return;
	const st = statSync(dir);
	if ((st.mode & 63) === 0) return;
	const warning = `${dir} is accessible to other users (mode ${(st.mode & 511).toString(8)}). Fix: chmod 700 ${dir}`;
	if (basename(dir) === ".admobctl" && st.uid === process.getuid()) try {
		chmodSync(dir, 448);
		return;
	} catch {}
	log.warn(warning);
}

//#endregion
export { ensurePrivateDir };