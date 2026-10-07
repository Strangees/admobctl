import { VERSION } from "../version.js";
import type { AppRef } from "./aliases.js";
import { log } from "./log.js";
import type { AdmobService } from "./service.js";

/** Google's certification authority ID (TAG-ID), the 4th field of an AdMob line. */
export const GOOGLE_CERT_ID = "f08c47fec0942fa0";

const ITUNES_LOOKUP = "https://itunes.apple.com/lookup";
const TIMEOUT_MS = 10_000;
/** Some CDNs and bot filters refuse requests without one; this also tells site owners who is asking. */
const USER_AGENT = `admobctl/${VERSION} (+https://github.com/Strangees/admobctl)`;

export interface AppAdsRecord {
  /** Lowercased, e.g. google.com */
  domain: string;
  /** Lowercased, e.g. pub-… */
  publisherId: string;
  /** Uppercased: DIRECT or RESELLER */
  relationship: string;
  certId?: string;
  /** 1-based line number in the file. */
  line: number;
}

/**
 * Records from an app-ads.txt body (IAB format). Comments, blank lines and `key=value` variables are skipped. Per the
 * IAB spec, CR, LF and CRLF all end a record, and extension data follows a ";" at the end of a record.
 */
export function parseAppAds(body: string): AppAdsRecord[] {
  const records: AppAdsRecord[] = [];
  body.split(/\r\n|\r|\n/).forEach((raw, i) => {
    const text = raw.replace(/#.*/, "").replace(/;.*/, "").trim();
    if (!text || /^[a-z_-]+\s*=/i.test(text)) return;
    const [domain, publisherId, relationship, certId] = text.split(",").map((f) => f.trim());
    if (!domain || !publisherId || !relationship) return;
    const rec: AppAdsRecord = {
      domain: domain.toLowerCase(),
      publisherId: publisherId.toLowerCase(),
      relationship: relationship.toUpperCase(),
      line: i + 1,
    };
    if (certId) rec.certId = certId.toLowerCase();
    records.push(rec);
  });
  return records;
}

/**
 * The host AdMob crawls for a developer website: the hostname only, without a leading www. or m.
 * Undefined when the input is not an http(s) website.
 */
export function appAdsHost(website: string): string | undefined {
  const s = website.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  const host = url.hostname.toLowerCase();
  if (!host.includes(".")) return undefined;
  return host.replace(/^(www|m)\./, "");
}

export type AppAdsStatus =
  | "ok"
  | "missing-file"
  | "html"
  | "no-line"
  | "reseller-only"
  | "unreachable"
  | "no-website"
  | "unknown-website"
  | "not-linked";

/** Statuses that cost ad revenue. unknown-website and not-linked are gaps in what we could check, not findings. */
const PROBLEMS = new Set<AppAdsStatus>(["missing-file", "html", "no-line", "reseller-only", "unreachable", "no-website"]);

export type WebsiteSource = "store" | "flag" | "config";

export interface AppAdsAppResult {
  app: string;
  appId: string;
  name: string;
  platform: string;
  status: AppAdsStatus;
  detail: string;
  website?: string;
  websiteSource?: WebsiteSource;
  /** Every app-ads.txt URL requested for this app, in order. */
  checked: string[];
  /** Where the file was read from (after redirects). */
  fileUrl?: string;
  notes: string[];
}

export interface AppAdsResult {
  account: string;
  publisherId: string;
  /** The line every developer website needs. */
  expectedLine: string;
  apps: AppAdsAppResult[];
  problems: number;
  summary: string[];
}

export interface AppAdsOptions {
  app?: string;
  /** Developer website for apps whose store listing cannot be read (Android). */
  website?: string;
}

type Probe =
  | { kind: "file"; url: string; body: string }
  | { kind: "html"; url: string }
  | { kind: "status"; url: string; status: number }
  | { kind: "error"; url: string; message: string };

async function probe(doFetch: typeof fetch, url: string): Promise<Probe> {
  log.debug(`GET ${url}`);
  try {
    const res = await doFetch(url, { redirect: "follow", headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await res.text();
    const finalUrl = res.url || url;
    if (!res.ok) return { kind: "status", url: finalUrl, status: res.status };
    // A catch-all page (common with single-page sites) answers 200 with HTML instead of the file.
    if (/html/i.test(res.headers.get("content-type") ?? "") || body.trimStart().startsWith("<")) return { kind: "html", url: finalUrl };
    return { kind: "file", url: finalUrl, body };
  } catch (err) {
    return { kind: "error", url, message: (err as Error).message };
  }
}

/** https first, then http, like AdMob's crawler. */
async function fetchAppAds(doFetch: typeof fetch, host: string): Promise<{ checked: string[]; result: Probe }> {
  const httpsUrl = `https://${host}/app-ads.txt`;
  const httpsResult = await probe(doFetch, httpsUrl);
  if (httpsResult.kind === "file") return { checked: [httpsUrl], result: httpsResult };
  const httpUrl = `http://${host}/app-ads.txt`;
  const httpResult = await probe(doFetch, httpUrl);
  if (httpResult.kind === "file") return { checked: [httpsUrl, httpUrl], result: httpResult };
  // Report an answer from the server over a network error.
  return { checked: [httpsUrl, httpUrl], result: httpsResult.kind === "error" ? httpResult : httpsResult };
}

/** App Store ID → marketing URL (null when the listing has none). Undefined when the lookup itself failed. */
async function lookupIosWebsites(doFetch: typeof fetch, storeIds: string[]): Promise<Map<string, string | null> | undefined> {
  if (!storeIds.length) return new Map();
  const url = `${ITUNES_LOOKUP}?id=${storeIds.map(encodeURIComponent).join(",")}`;
  log.debug(`GET ${url}`);
  try {
    const res = await doFetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { results?: Array<{ trackId?: number; sellerUrl?: string }> };
    return new Map((data.results ?? []).map((r) => [String(r.trackId), r.sellerUrl || null]));
  } catch (err) {
    log.debug(`App Store lookup failed: ${(err as Error).message}`);
    return undefined;
  }
}

interface Site {
  website?: string;
  source?: WebsiteSource;
  /** Set when there is nothing to fetch. */
  status?: AppAdsStatus;
  detail?: string;
  notes: string[];
}

function fallbackSite(opts: AppAdsOptions, configured: string | undefined, notes: string[], unknownDetail: string): Site {
  if (opts.website) return { website: opts.website, source: "flag", notes };
  if (configured) return { website: configured, source: "config", notes };
  return { status: "unknown-website", detail: unknownDetail, notes };
}

const SET_WEBSITE = "pass --website <url> or run: admobctl config set websites.<alias> <url>";

/** The configured website for one app: per-app (by alias, then app ID), then profile-wide. */
function configuredWebsite(app: AppRef, profile: { website?: string; websites?: Record<string, string> }): string | undefined {
  return profile.websites?.[app.alias] ?? profile.websites?.[app.appId] ?? profile.website;
}

function siteFor(app: AppRef, ios: Map<string, string | null> | undefined, opts: AppAdsOptions, configured: string | undefined): Site {
  if (!app.storeId) {
    return { status: "not-linked", detail: "Not linked to an app store; AdMob verifies app-ads.txt only for store-linked apps.", notes: [] };
  }
  if (app.platform === "IOS") {
    const hit = ios?.get(app.storeId);
    if (hit) return { website: hit, source: "store", notes: [] };
    if (hit === null) {
      return {
        status: "no-website",
        detail: "The App Store listing has no marketing URL, so AdMob cannot find app-ads.txt. Add one in App Store Connect.",
        notes: [],
      };
    }
    const why = ios ? "was not found in the App Store lookup (US store)" : "could not be looked up in the App Store";
    return fallbackSite(opts, configured, [`The listing ${why}; checked the ${opts.website ? "--website" : "configured"} website instead.`], `The listing ${why}; ${SET_WEBSITE}`);
  }
  return fallbackSite(
    opts,
    configured,
    [],
    `Google Play listings cannot be read without Play Console access. AdMob uses the website in the listing's contact details; ${SET_WEBSITE}`,
  );
}

/** Only 404 and 410 say the file is not there. Anything else (a bot filter, rate limit or server error) means it could not be read. */
function statusVerdict(url: string, status: number): Pick<AppAdsAppResult, "status" | "detail" | "notes"> {
  if (status === 404 || status === 410) return { status: "missing-file", detail: `${url} returned HTTP ${status}.`, notes: [] };
  const why =
    status === 401 || status === 403 || status === 429
      ? "the request was blocked, perhaps by a firewall, bot filter or rate limit"
      : status >= 500
        ? "the site had a server error"
        : "the site did not return it";
  return { status: "unreachable", detail: `Could not read ${url}: ${why} (HTTP ${status}). Check that it opens in a browser.`, notes: [] };
}

function verdict(result: Probe, host: string, publisherId: string): Pick<AppAdsAppResult, "status" | "detail" | "fileUrl" | "notes"> {
  if (result.kind === "error") return { status: "unreachable", detail: `Could not reach ${host}: ${result.message}`, notes: [] };
  if (result.kind === "status") return statusVerdict(result.url, result.status);
  if (result.kind === "html") {
    return { status: "html", detail: `${result.url} returned a web page, not a plain-text app-ads.txt.`, fileUrl: result.url, notes: [] };
  }
  const pub = publisherId.toLowerCase();
  const google = parseAppAds(result.body).filter((r) => r.domain === "google.com");
  const mine = google.filter((r) => r.publisherId === pub);
  const direct = mine.find((r) => r.relationship === "DIRECT");
  if (direct) {
    const notes =
      direct.certId && direct.certId !== GOOGLE_CERT_ID
        ? [`Line ${direct.line} has certification ID ${direct.certId}; Google's is ${GOOGLE_CERT_ID}.`]
        : [];
    return { status: "ok", detail: `${result.url} lists ${publisherId} as DIRECT (line ${direct.line}).`, fileUrl: result.url, notes };
  }
  if (mine.length) {
    return {
      status: "reseller-only",
      detail: `${result.url} lists ${publisherId} as ${mine[0]!.relationship} (line ${mine[0]!.line}); AdMob needs DIRECT.`,
      fileUrl: result.url,
      notes: [],
    };
  }
  // The app ID form (ca-app-pub-…, sometimes with ~app or /unit) is a common mix-up for the publisher ID.
  const prefixed = google.find((r) => r.publisherId.startsWith("ca-app-") && r.publisherId.slice(7).split(/[~/]/)[0] === pub);
  if (prefixed) {
    return {
      status: "no-line",
      detail: `${result.url} lists ${prefixed.publisherId} (line ${prefixed.line}); app-ads.txt takes the publisher ID: use ${publisherId}, not ca-app-${publisherId}.`,
      fileUrl: result.url,
      notes: [],
    };
  }
  const others = [...new Set(google.map((r) => r.publisherId))];
  // Ad network files can list dozens of Google publishers; a few are enough to spot a typo.
  const listed = others.length > 3 ? `${others.slice(0, 3).join(", ")} and ${others.length - 3} more` : others.join(", ");
  return {
    status: "no-line",
    detail: `${result.url} has no google.com line for ${publisherId}${others.length ? ` (it lists ${listed})` : ""}.`,
    fileUrl: result.url,
    notes: [],
  };
}

function summarize(apps: AppAdsAppResult[], expectedLine: string): { problems: number; summary: string[] } {
  const problems = apps.filter((a) => PROBLEMS.has(a.status)).length;
  const ok = apps.filter((a) => a.status === "ok").length;
  const unknown = apps.filter((a) => a.status === "unknown-website").length;
  const summary: string[] = [];
  if (problems) {
    summary.push(`${problems} of ${apps.length} apps have an app-ads.txt problem that can cost ad revenue.`);
    summary.push(`Each developer website needs this line in /app-ads.txt: ${expectedLine}`);
    summary.push("AdMob can take up to 24 hours to see a fixed file.");
  } else if (ok) {
    summary.push(`${ok} of ${apps.length} apps have a valid app-ads.txt line.`);
  }
  if (unknown) summary.push(`${unknown} apps were not checked because their developer website is unknown; ${SET_WEBSITE}`);
  return { problems, summary };
}

/**
 * Check each app's app-ads.txt the way AdMob's crawler does: developer website from the store listing,
 * hostname without www./m., https then http, and a google.com line with this publisher ID marked DIRECT.
 */
export async function checkAppAds(svc: AdmobService, opts: AppAdsOptions): Promise<AppAdsResult> {
  const [account, all] = await Promise.all([svc.account(), svc.apps()]);
  const apps = opts.app ? [await svc.resolveApp(opts.app)] : all;
  const doFetch = svc.fetch;
  const ios = await lookupIosWebsites(doFetch, [...new Set(apps.filter((a) => a.platform === "IOS" && a.storeId).map((a) => a.storeId!))]);
  const expectedLine = `google.com, ${account.publisherId}, DIRECT, ${GOOGLE_CERT_ID}`;

  // One fetch per distinct host: an iOS/Android pair usually shares a website.
  const byHost = new Map<string, ReturnType<typeof fetchAppAds>>();
  const results = await Promise.all(
    apps.map(async (app): Promise<AppAdsAppResult> => {
      const base = { app: app.alias, appId: app.appId, name: app.name, platform: app.platform };
      const site = siteFor(app, ios, opts, configuredWebsite(app, svc.profile));
      if (site.status) return { ...base, status: site.status, detail: site.detail!, checked: [], notes: site.notes };
      const where = { website: site.website!, websiteSource: site.source! };
      const host = appAdsHost(site.website!);
      if (!host) {
        return { ...base, ...where, status: "no-website", detail: `"${site.website}" is not a website URL.`, checked: [], notes: site.notes };
      }
      let pending = byHost.get(host);
      if (!pending) byHost.set(host, (pending = fetchAppAds(doFetch, host)));
      const { checked, result } = await pending;
      const v = verdict(result, host, account.publisherId);
      return { ...base, ...where, ...v, checked, notes: [...site.notes, ...v.notes] };
    }),
  );
  return { account: account.name, publisherId: account.publisherId, expectedLine, apps: results, ...summarize(results, expectedLine) };
}
