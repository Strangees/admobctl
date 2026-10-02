import { requestJson, type HttpOptions } from "./http.js";
import { processLimiters, type Limiters, type QuotaCategory } from "./ratelimit.js";
import { parseReport, type Report, type ReportSpec } from "./report.js";

export const API_BASE = "https://admob.googleapis.com/v1";

export interface PublisherAccount {
  name: string;
  publisherId: string;
  reportingTimeZone: string;
  currencyCode: string;
}

export interface App {
  name: string;
  appId: string;
  platform: string;
  manualAppInfo?: { displayName?: string };
  linkedAppInfo?: { appStoreId?: string; displayName?: string };
  appApprovalState?: string;
}

export interface AdUnit {
  name: string;
  adUnitId: string;
  appId: string;
  displayName: string;
  adFormat: string;
  adTypes?: string[];
}

export interface AdmobClientOptions extends HttpOptions {
  getToken: () => Promise<string>;
  quotaProject?: string;
  baseUrl?: string;
  /** Client-side quota limiters. Default: shared by the whole process. */
  limiters?: Limiters;
}

/** "pub-123" or "accounts/pub-123" → "accounts/pub-123" */
export function accountName(account: string): string {
  return account.startsWith("accounts/") ? account : `accounts/${account}`;
}

/** Thin, typed wrapper over the AdMob REST API v1. No business logic lives here. */
export class AdmobClient {
  constructor(private readonly opts: AdmobClientOptions) {}

  private async request<T>(quota: QuotaCategory, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    await (this.opts.limiters ?? processLimiters)[quota].take(this.opts.sleep);
    const headers: Record<string, string> = {
      authorization: `Bearer ${await this.opts.getToken()}`,
      accept: "application/json",
    };
    if (this.opts.quotaProject) headers["x-goog-user-project"] = this.opts.quotaProject;
    if (body !== undefined) headers["content-type"] = "application/json";
    const url = `${this.opts.baseUrl ?? API_BASE}/${path}`;
    return requestJson<T>(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, this.opts);
  }

  private async paginate<T>(quota: QuotaCategory, path: string, key: string): Promise<T[]> {
    const out: T[] = [];
    let pageToken: string | undefined;
    do {
      const qs = new URLSearchParams({ pageSize: "1000" });
      if (pageToken) qs.set("pageToken", pageToken);
      const page = await this.request<Record<string, unknown> & { nextPageToken?: string }>(quota, "GET", `${path}?${qs}`);
      out.push(...((page?.[key] as T[] | undefined) ?? []));
      pageToken = page?.nextPageToken || undefined;
    } while (pageToken);
    return out;
  }

  listAccounts(): Promise<PublisherAccount[]> {
    return this.paginate<PublisherAccount>("account", "accounts", "account");
  }

  listApps(account: string): Promise<App[]> {
    return this.paginate<App>("inventory", `${accountName(account)}/apps`, "apps");
  }

  listAdUnits(account: string): Promise<AdUnit[]> {
    return this.paginate<AdUnit>("inventory", `${accountName(account)}/adUnits`, "adUnits");
  }

  async networkReport(account: string, spec: ReportSpec | Record<string, unknown>): Promise<Report> {
    const raw = await this.request<unknown>("reporting", "POST", `${accountName(account)}/networkReport:generate`, { reportSpec: spec });
    return parseReport(raw);
  }

  async mediationReport(account: string, spec: ReportSpec | Record<string, unknown>): Promise<Report> {
    const raw = await this.request<unknown>("reporting", "POST", `${accountName(account)}/mediationReport:generate`, { reportSpec: spec });
    return parseReport(raw);
  }
}
