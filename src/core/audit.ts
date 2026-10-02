import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";

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
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "audit.log");
  appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}
