import { AdmobctlError } from "../errors.js";
import { defaultSleep, requestJson } from "../http.js";

const CRM = "https://cloudresourcemanager.googleapis.com/v3";
const SU = "https://serviceusage.googleapis.com/v1";
const POLL_MS = 2_000;
const OPERATION_TIMEOUT_MS = 120_000;

export interface CloudProject {
  projectId: string;
  name: string;
}

export interface CloudClientOptions {
  getToken: () => Promise<string>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface Operation {
  name: string;
  done?: boolean;
  error?: { code?: number; message?: string };
}

/**
 * Google Cloud setup calls (Resource Manager, Service Usage) made with the user's own token.
 * No quota header: both APIs accept user ADC tokens before a quota project exists (checked live 2026-10-05).
 */
export class CloudClient {
  constructor(private readonly o: CloudClientOptions) {}

  private async call<T>(method: "GET" | "POST", url: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${await this.o.getToken()}`, accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    return requestJson<T>(
      url,
      { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
      // Enabling is not idempotent-safe to blind-retry mid-operation; reads may retry.
      { fetch: this.o.fetch, sleep: this.o.sleep, retries: method === "GET" ? 2 : 0 },
    );
  }

  async listProjects(): Promise<CloudProject[]> {
    const out: CloudProject[] = [];
    let pageToken: string | undefined;
    do {
      const qs = new URLSearchParams({ pageSize: "100", ...(pageToken ? { pageToken } : {}) });
      const page = await this.call<{ projects?: Array<{ projectId: string; displayName?: string; state?: string }>; nextPageToken?: string }>(
        "GET",
        `${CRM}/projects:search?${qs}`,
      );
      for (const p of page?.projects ?? []) {
        if (!p.state || p.state === "ACTIVE") out.push({ projectId: p.projectId, name: p.displayName ?? p.projectId });
      }
      pageToken = page?.nextPageToken || undefined;
    } while (pageToken);
    return out;
  }

  async getProject(id: string): Promise<CloudProject> {
    try {
      const p = await this.call<{ projectId: string; displayName?: string }>("GET", `${CRM}/projects/${encodeURIComponent(id)}`);
      return { projectId: p.projectId, name: p.displayName ?? p.projectId };
    } catch (err) {
      if (err instanceof AdmobctlError && (err.code === "PERMISSION_DENIED" || err.code === "NOT_FOUND")) {
        throw new AdmobctlError("NOT_FOUND", `Google Cloud project "${id}" was not found, or your account cannot access it.`, {
          status: err.status,
          cause: err,
          fix: "admobctl setup project list",
        });
      }
      throw err;
    }
  }

  async serviceStates(project: string, services: string[]): Promise<Record<string, "ENABLED" | "DISABLED">> {
    const entries = await Promise.all(
      services.map(async (s) => {
        const r = await this.call<{ state?: string }>("GET", `${SU}/projects/${encodeURIComponent(project)}/services/${s}`);
        return [s, r?.state === "ENABLED" ? "ENABLED" : "DISABLED"] as const;
      }),
    );
    return Object.fromEntries(entries);
  }

  /** Enable services and wait for the long-running operation to finish. */
  async enableServices(project: string, services: string[]): Promise<void> {
    let op = await this.call<Operation>("POST", `${SU}/projects/${encodeURIComponent(project)}/services:batchEnable`, { serviceIds: services });
    const sleep = this.o.sleep ?? defaultSleep;
    const now = this.o.now ?? Date.now;
    const start = now();
    while (!op.done) {
      if (now() - start >= OPERATION_TIMEOUT_MS) {
        throw new AdmobctlError("API_ERROR", `Enabling ${services.join(", ")} in ${project} is still running after ${OPERATION_TIMEOUT_MS / 1000} seconds.`, {
          fix: "admobctl setup status",
        });
      }
      await sleep(POLL_MS);
      op = await this.call<Operation>("GET", `${SU}/${op.name}`);
    }
    if (op.error) {
      throw new AdmobctlError("API_ERROR", `Google could not enable ${services.join(", ")} in ${project}: ${op.error.message ?? "unknown error"}`, {
        fix: "admobctl setup status",
      });
    }
  }
}
