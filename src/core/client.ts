import { AdmobctlError, MONETIZATION_SCOPE, PAYMENTS_LOGIN_COMMAND, WRITE_LOGIN_COMMAND } from "./errors.js";
import { requestJson, type HttpOptions } from "./http.js";
import { processLimiters, type Limiters, type QuotaCategory } from "./ratelimit.js";
import { parseReport, type Report, type ReportSpec } from "./report.js";

export const API_BASE = "https://admob.googleapis.com/v1";
/** Beta surface: ad sources, mediation groups, ad unit mappings, campaign reports, and every write method. */
export const API_BASE_BETA = "https://admob.googleapis.com/v1beta";
/** AdSense Management API: only payments, for the unpaid balance (which includes AdMob earnings). */
export const ADSENSE_API_BASE = "https://adsense.googleapis.com/v2";

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

export interface AdsensePayment {
  /** accounts/{pub}/payments/unpaid, or accounts/{pub}/payments/{yyyymmdd} for a paid payment. */
  name: string;
  /** Formatted, e.g. "NOK 1,234.56". */
  amount: string;
  date?: { year: number; month: number; day: number };
}

export interface CampaignReportSpec {
  dateRange: ReportSpec["dateRange"];
  dimensions: string[];
  metrics: string[];
  languageCode?: string;
}

type ApiVersion = "v1" | "v1beta" | "adsense";

export interface AdmobClientOptions extends HttpOptions {
  getToken: () => Promise<string>;
  quotaProject?: string;
  baseUrl?: string;
  betaBaseUrl?: string;
  adsenseBaseUrl?: string;
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
    http: Pick<HttpOptions, "retries"> = {},
  ): Promise<T> {
    const limiter = (this.opts.limiters ?? processLimiters)[quota];
    const headers: Record<string, string> = {
      authorization: `Bearer ${await this.opts.getToken()}`,
      accept: "application/json",
    };
    if (this.opts.quotaProject) headers["x-goog-user-project"] = this.opts.quotaProject;
    if (body !== undefined) headers["content-type"] = "application/json";
    const base =
      version === "v1"
        ? (this.opts.baseUrl ?? API_BASE)
        : version === "v1beta"
          ? (this.opts.betaBaseUrl ?? API_BASE_BETA)
          : (this.opts.adsenseBaseUrl ?? ADSENSE_API_BASE);
    try {
      return await requestJson<T>(
        `${base}/${path}`,
        { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
        // Every attempt, retries included, takes a rate-limiter slot.
        { ...this.opts, ...http, beforeAttempt: () => limiter.take(this.opts.sleep) },
      );
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

  // ── v1beta writes (admob.monetization scope) ─────────────────────

  /** Send a write to v1beta. `path` is relative to the version root, e.g. accounts/pub-1/adUnits. */
  async write<T = unknown>(method: "POST" | "PATCH", path: string, body: unknown, query?: Record<string, string>): Promise<T> {
    const qs = query && Object.keys(query).length ? `?${new URLSearchParams(query)}` : "";
    try {
      // Writes are not idempotent (creates, new "-1" lines): a retry after a timeout or 5xx could apply them twice.
      return await this.request<T>("inventory", method, `${path}${qs}`, body, "v1beta", { retries: 0 });
    } catch (err) {
      if (err instanceof AdmobctlError && (err.status === undefined || err.status >= 500)) {
        throw new AdmobctlError(err.code, `${err.message} The change may have been applied anyway.`, {
          status: err.status,
          cause: err,
          fix: "Check with admobctl (e.g. apps list, ad-units list, mediation-groups show) before retrying, so it is not applied twice.",
        });
      }
      if (err instanceof AdmobctlError && err.code === "AUTH_SCOPE_MISSING") {
        throw new AdmobctlError("AUTH_SCOPE_MISSING", "Write commands need the admob.monetization scope, which your credentials do not include.", {
          status: err.status,
          cause: err,
          fix: `${WRITE_LOGIN_COMMAND}  (or: admobctl auth login --write)`,
        });
      }
      throw err;
    }
  }

  // ── AdSense Management API (adsense.readonly scope) ──────────────

  /** All payments of the publisher's Google payments account: `unpaid` plus paid ones. Not paginated. */
  async listPayments(account: string): Promise<AdsensePayment[]> {
    try {
      const page = await this.request<{ payments?: AdsensePayment[] }>("account", "GET", `${accountName(account)}/payments`, undefined, "adsense");
      return page?.payments ?? [];
    } catch (err) {
      throw paymentsError(err, account.replace(/^accounts\//, ""));
    }
  }

  async campaignReport(account: string, spec: CampaignReportSpec): Promise<Report> {
    try {
      const raw = await this.request<unknown>("reporting", "POST", `${accountName(account)}/campaignReport:generate`, { reportSpec: spec }, "v1beta");
      return parseReport(raw);
    } catch (err) {
      // A well-formed spec still gets a bare 400 INVALID_ARGUMENT when the account has no
      // app-promotion campaigns or is not enabled for this v1beta method.
      if (err instanceof AdmobctlError && err.status === 400) {
        throw new AdmobctlError(
          "CAMPAIGN_REPORT_REJECTED",
          `The AdMob API rejected the campaign report (400: ${err.message.replace(/^AdMob API error 400: /, "")}). This usually means the account has no AdMob app-promotion campaigns, or is not enabled for campaignReport (AdMob API v1beta).`,
          {
            status: 400,
            cause: err,
            fix: "Check AdMob → Campaigns for app-promotion campaigns. If you run some there, ask your Google AdMob account manager to enable AdMob API (v1beta) campaign reporting for this account.",
          },
        );
      }
      throw err;
    }
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

/** AdSense payments failures, phrased for `finance balance` (an optional, extra setup). */
function paymentsError(err: unknown, publisherId: string): unknown {
  if (!(err instanceof AdmobctlError)) return err;
  const opts = { status: err.status, cause: err };
  switch (err.code) {
    case "AUTH_SCOPE_MISSING":
      return new AdmobctlError("AUTH_SCOPE_MISSING", "finance balance needs the adsense.readonly scope, which your credentials do not include.", {
        ...opts,
        fix: `${PAYMENTS_LOGIN_COMMAND}  (add ,${MONETIZATION_SCOPE} to --scopes if you use the write commands; or: admobctl auth login --payments)`,
      });
    case "API_NOT_ENABLED":
      return new AdmobctlError("API_NOT_ENABLED", err.message, {
        ...opts,
        fix: `${err.fix}  (run it as a project owner: if gcloud is signed in as a service account, add --account <your Google account>; allow a minute to take effect)`,
      });
    case "PERMISSION_DENIED":
    case "NOT_FOUND":
      return new AdmobctlError("PAYMENTS_UNAVAILABLE", `No Google payments (AdSense) account was found for ${publisherId}, so the unpaid balance is unavailable.`, {
        ...opts,
        fix: "Check AdMob → Payments in the web UI. If your balance shows there, run admobctl auth doctor and make sure you signed in as the AdMob account owner.",
      });
    default:
      return err;
  }
}
