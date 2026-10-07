import { chmodSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/**
 * Write `content` to `file` readable only by the current user (0600), atomically. `mode` only applies when a file is
 * created, so writing in place would put the data into an existing 0644 file before any chmod: write a fresh temp file
 * next to it instead (wx: never reuse a stale one) and rename it over the target.
 */
export function writePrivateFile(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  try {
    writeFileSync(tmp, content, { mode: 0o600, flag: "wx" });
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  chmodSync(file, 0o600);
}
