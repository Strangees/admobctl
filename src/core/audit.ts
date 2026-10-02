import { appendFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
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
