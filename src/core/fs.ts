import { chmodSync, mkdirSync, statSync } from "node:fs";
import { basename } from "node:path";
import { log } from "./log.js";

/**
 * Make sure `dir` exists and is private to the current user.
 * - A dir we create is made 0700.
 * - A pre-existing group/world-accessible dir is tightened to 0700 only when it is clearly
 *   admobctl's own (basename `.admobctl`, which includes the default `~/.admobctl`) and owned by us.
 *   Anything else (ADMOBCTL_HOME could be $HOME or /tmp) is left alone, with a warning naming the fix.
 * - No-op on Windows / where POSIX uids are unavailable.
 */
export function ensurePrivateDir(dir: string): void {
  // `recursive` returns the first dir it created (undefined if it already existed); chmod the leaf, past the umask.
  if (mkdirSync(dir, { recursive: true, mode: 0o700 }) !== undefined) {
    chmodSync(dir, 0o700);
    return;
  }
  if (process.platform === "win32" || typeof process.getuid !== "function") return;
  const st = statSync(dir);
  if ((st.mode & 0o077) === 0) return;
  const warning = `${dir} is accessible to other users (mode ${(st.mode & 0o777).toString(8)}). Fix: chmod 700 ${dir}`;
  if (basename(dir) === ".admobctl" && st.uid === process.getuid()) {
    try {
      chmodSync(dir, 0o700);
      return;
    } catch {
      // e.g. read-only mount: fall through to the warning rather than failing the write.
    }
  }
  log.warn(warning);
}
