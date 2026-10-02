import { AdmobctlError } from "./errors.js";
import { requestJson, type HttpOptions } from "./http.js";
import { processLimiters, type Limiters, type QuotaCategory } from "./ratelimit.js";
import { parseReport, type Report, type ReportSpec } from "./report.js";

export const API_BASE = "https://admob.googleapis.com/v1";
/** Beta surface: ad sources, mediation groups, ad unit mappings, campaign reports, and every write method. */
export const API_BASE_BETA = "https://admob.googleapis.com/v1beta";

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

export interface AdSource {
  name: string;
  adSourceId: string;
  title: string;
}

export interface Adapter {
  name: string;
  adapterId: string;
  title: string;
  platform: string;
  formats?: string[];
  adapterConfigMetadata?: Array<{ adapterConfigMetadataId: string; adapterConfigMetadataLabel: string; isRequired?: boolean }>;
}

export interface MediationGroupLine {
  id: string;
  displayName?: string;
  adSourceId: string;
  cpmMode?: string;
  /** USD micros; ignored for LIVE lines. */
  cpmMicros?: string;
  state?: string;
  experimentVariant?: string;
  /** ad unit ID → ad unit mapping resource name */
  adUnitMappings?: Record<string, string>;
}

export interface MediationGroup {
  name: string;
  mediationGroupId: string;
  displayName: string;
  state?: string;
  targeting?: {
    platform?: string;
    format?: string;
    adUnitIds?: string[];
    targetedRegionCodes?: string[];
    excludedRegionCodes?: string[];
    idfaTargeting?: string;
  };
  mediationGroupLines?: Record<string, MediationGroupLine>;
  mediationAbExperimentState?: string;
}

export interface AdUnitMapping {
  name: string;
  adapterId: string;
  displayName?: string;
  state?: string;
  adUnitConfigurations?: Record<string, string>;
}

export interface CampaignReportSpec {
  dateRange: ReportSpec["dateRange"];
  dimensions: string[];
  metrics: string[];
  languageCode?: string;
}

type ApiVersion = "v1" | "v1beta";

export interface AdmobClientOptions extends HttpOptions {
  getToken: () => Promise<string>;
  quotaProject?: string;
  baseUrl?: string;
  betaBaseUrl?: string;
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

  private async request<T>(
    quota: QuotaCategory,
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
    version: ApiVersion = "v1",
  ): Promise<T> {
    await (this.opts.limiters ?? processLimiters)[quota].take(this.opts.sleep);
    const headers: Record<string, string> = {
      authorization: `Bearer ${await this.opts.getToken()}`,
      accept: "application/json",
    };
    if (this.opts.quotaProject) headers["x-goog-user-project"] = this.opts.quotaProject;
    if (body !== undefined) headers["content-type"] = "application/json";
    const base = version === "v1" ? (this.opts.baseUrl ?? API_BASE) : (this.opts.betaBaseUrl ?? API_BASE_BETA);
    try {
      return await requestJson<T>(`${base}/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, this.opts);
    } catch (err) {
      throw version === "v1beta" ? betaError(err, path, method) : err;
    }
  }

  private async paginate<T>(
    quota: QuotaCategory,
    path: string,
    key: string,
    opts: { version?: ApiVersion; params?: Record<string, string> } = {},
  ): Promise<T[]> {
    const out: T[] = [];
    let pageToken: string | undefined;
    do {
      const qs = new URLSearchParams({ pageSize: "1000", ...opts.params });
      if (pageToken) qs.set("pageToken", pageToken);
      const page = await this.request<Record<string, unknown> & { nextPageToken?: string }>(quota, "GET", `${path}?${qs}`, undefined, opts.version);
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

  // ── v1beta reads ──────────────────────────────────────────────────

  listAdSources(account: string): Promise<AdSource[]> {
    return this.paginate<AdSource>("inventory", `${accountName(account)}/adSources`, "adSources", { version: "v1beta" });
  }

  listAdapters(account: string, adSourceId: string): Promise<Adapter[]> {
    return this.paginate<Adapter>("inventory", `${accountName(account)}/adSources/${adSourceId}/adapters`, "adapters", { version: "v1beta" });
  }

  /** `filter` uses the API's EBNF syntax, e.g. IN(FORMAT, "BANNER") AND CONTAINS_ANY(APP_IDS, "…"). */
  listMediationGroups(account: string, filter?: string): Promise<MediationGroup[]> {
    return this.paginate<MediationGroup>("inventory", `${accountName(account)}/mediationGroups`, "mediationGroups", {
      version: "v1beta",
      params: filter ? { filter } : undefined,
    });
  }

  /** `adUnit` is the ad unit's resource name, accounts/{pub}/adUnits/{fragment}. */
  listAdUnitMappings(adUnit: string): Promise<AdUnitMapping[]> {
    return this.paginate<AdUnitMapping>("inventory", `${adUnit}/adUnitMappings`, "adUnitMappings", { version: "v1beta" });
  }

  async campaignReport(account: string, spec: CampaignReportSpec): Promise<Report> {
    const raw = await this.request<unknown>("reporting", "POST", `${accountName(account)}/campaignReport:generate`, { reportSpec: spec }, "v1beta");
    return parseReport(raw);
  }
}

/** ("accounts/pub-1/mediationGroups?pageSize=…", GET) → "mediationGroups.list", for messages. */
function methodName(path: string, httpMethod: string): string {
  const segments = path.split("?")[0]!.split("/");
  const last = segments[segments.length - 1]!;
  if (last.includes(":")) return last.replace(":", ".");
  const collection = segments.length % 2 === 1 ? last : segments[segments.length - 2]!;
  return `${collection}.${httpMethod === "GET" ? "list" : httpMethod === "PATCH" ? "patch" : "create"}`;
}

/** A 403 from a v1beta method usually means the account is not allowlisted for the beta, not a missing grant. */
function betaError(err: unknown, path: string, httpMethod: string): unknown {
  if (!(err instanceof AdmobctlError) || err.code !== "PERMISSION_DENIED") return err;
  return new AdmobctlError(
    "BETA_ACCESS_DENIED",
    `Permission denied for ${methodName(path, httpMethod)} (AdMob API v1beta). Google limits several v1beta methods to allowlisted accounts.`,
    {
      status: err.status,
      cause: err,
      fix: "If `admobctl accounts list` works, ask your Google AdMob account manager to enable AdMob API (v1beta) access for this publisher account.",
    },
  );
}
