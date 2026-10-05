import { appendFileSync, chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AdmobctlError } from "./errors.js";
import { ensurePrivateDir } from "./fs.js";

export interface AuditEntry {
  time: string;
  profile: string;
  action: string;
  method: string;
  path: string;
  query?: Record<string, string>;
  body: unknown;
  ok: boolean;
  /** Resource name the API returned, when there is one. */
  result?: string;
  error?: string;
}

/** Append one JSON line per applied write to <configDir>/audit.log (0600). */
export function appendAudit(dir: string, entry: AuditEntry): void {
  ensurePrivateDir(dir);
  const file = join(dir, "audit.log");
  appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export interface AuditLog {
  file: string;
  /** Newest first. */
  entries: AuditEntry[];
  /** Lines that are not audit entries (a damaged or hand-edited log). */
  skipped: number;
}

/** Read <configDir>/audit.log back, newest first. A missing log is an empty one. */
export function readAudit(dir: string, opts: { last?: number; failed?: boolean } = {}): AuditLog {
  const file = join(dir, "audit.log");
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new AdmobctlError("CONFIG", `Could not read ${file}: ${(err as Error).message}`, {
        fix: `ls -l ${file}  # it must be a file you can read; move it aside to start a new log`,
        cause: err,
      });
    }
  }
  let skipped = 0;
  let entries: AuditEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as AuditEntry;
      if (typeof e?.time !== "string" || typeof e.action !== "string" || typeof e.method !== "string" || typeof e.path !== "string") {
        throw new Error("not an entry");
      }
      entries.push(e);
    } catch {
      skipped++;
    }
  }
  entries.reverse();
  if (opts.failed) entries = entries.filter((e) => !e.ok);
  if (opts.last !== undefined) entries = entries.slice(0, opts.last);
  return { file, entries, skipped };
}
