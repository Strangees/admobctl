import type { AppRef } from "./aliases.js";
import { compareDates, formatDate, todayIn, type ApiDate, type DateRange } from "./dates.js";
import { usageError } from "./errors.js";
import { ESTIMATE_LABEL } from "./finance.js";
import { checkRangeArgs, pct, perMille, ratio, resolveInsightRange } from "./insights.js";
import { formatMicros, microsToAmount, sumMicros } from "./money.js";
import type { DimensionValue, Report } from "./report.js";
import type { AdmobService, StreamedReportKind } from "./service.js";

/** Curated analyses on report dimensions the plain reports leave to the user. */

export interface AnalyzeRange {
  /** Number of complete days ending yesterday. Not together with from/to. */
  last?: number;
  from?: string;
  to?: string;
}

export interface Finding {
  kind: string;
  key: string;
  label: string;
  message: string;
}

export interface Base {
  from: string;
  to: string;
  timeZone: string;
  highlights: Finding[];
  summary: string[];
  /** Partial recent data, API warnings, data that does not go back far enough. */
  notices: string[];
}

/** A version or line needs this many requests (and this share of its group) before we judge it. */
const MIN_REQUESTS = 1000;
const MIN_SHARE = 0.05;

/** Rows stay in the output below MIN_REQUESTS, so say that their rates are not findings. */
function thinDataNotice(thin: number, total: number, what: string, also = ""): string[] {
  return thin ? [`${thin} of ${total} ${what} had fewer than ${MIN_REQUESTS} requests${also}; treat their rates as noise, not findings.`] : [];
}

export async function fetchReport(
  svc: AdmobService,
  kind: StreamedReportKind,
  opts: AnalyzeRange & { by: string[]; metrics: string[]; filters?: Record<string, string[]>; currency?: string },
) {
  checkRangeArgs(opts);
  const acct = await svc.account();
  const range = resolveInsightRange(opts, todayIn(acct.reportingTimeZone, svc.now()));
  const { report, notices } = await svc.rawReport(kind, {
    dateRange: range,
    by: opts.by,
    metrics: opts.metrics,
    filters: opts.filters,
    currency: opts.currency,
  });
  return {
    report,
    range,
    from: formatDate(range.startDate),
    to: formatDate(range.endDate),
    currency: report.currency ?? acct.currencyCode,
    timeZone: report.timeZone ?? acct.reportingTimeZone,
    notices: [...report.warnings.map((w) => `API warning: ${w}`), ...notices],
  };
}

const label = (v: DimensionValue | undefined) => v?.label ?? v?.value ?? "(unknown)";
const metric = (row: Report["rows"][number], m: string) => row.metrics[m] ?? 0;
const startsBefore = (range: DateRange, d: ApiDate) => compareDates(range.startDate, d) < 0;

// ── versions ─────────────────────────────────────────────────────────

export const VERSION_KINDS = ["sdk", "app", "os"] as const;
export type VersionKind = (typeof VERSION_KINDS)[number];
const VERSION_DIM: Record<VersionKind, string> = { sdk: "GMA_SDK_VERSION", app: "APP_VERSION_NAME", os: "MOBILE_OS_VERSION" };
const VERSION_NOUN: Record<VersionKind, string> = { sdk: "SDK version", app: "app version", os: "OS version" };

export interface VersionsOptions extends AnalyzeRange {
  by: VersionKind;
  /** Only this app (alias, ID or name). */
  app?: string;
}

export interface VersionRow {
  /** Platform for SDK and OS versions, app alias for app versions. */
  group: string;
  version: string;
  requests: number;
  matched_requests: number;
  impressions: number;
  clicks: number;
  match_rate: number;
  show_rate: number;
  ctr: number;
  /** Share of the group's ad requests. */
  request_share: number;
  /** False below MIN_REQUESTS requests: the rates are too noisy to act on. */
  enough_data: boolean;
}

export interface VersionsResult extends Base {
  by: VersionKind;
  group_by: "platform" | "app";
  rows: VersionRow[];
}

export async function analyzeVersions(svc: AdmobService, opts: VersionsOptions): Promise<VersionsResult> {
  if (!VERSION_KINDS.includes(opts.by)) throw usageError(`--by must be one of ${VERSION_KINDS.join(", ")}`);
  checkRangeArgs(opts);
  const groupDim = opts.by === "app" ? "APP" : "PLATFORM";
  const dim = VERSION_DIM[opts.by];
  // Traffic metrics only: the metrics guide says version dimensions do not combine with earnings.
  const [r, apps] = await Promise.all([
    fetchReport(svc, "network", {
      ...opts,
      by: [groupDim, dim],
      metrics: ["AD_REQUESTS", "MATCHED_REQUESTS", "IMPRESSIONS", "CLICKS"],
      filters: opts.app ? { app: [opts.app] } : undefined,
    }),
    groupDim === "APP" ? svc.apps() : Promise.resolve([] as AppRef[]),
  ]);
  const alias = new Map(apps.map((a) => [a.appId, a.alias]));
  const groupOf = (row: Report["rows"][number]) => {
    const v = row.dimensions[groupDim];
    return groupDim === "APP" ? (alias.get(v?.value ?? "") ?? label(v)) : label(v);
  };

  const groupRequests = new Map<string, number>();
  for (const row of r.report.rows) groupRequests.set(groupOf(row), (groupRequests.get(groupOf(row)) ?? 0) + metric(row, "AD_REQUESTS"));

  const rows: VersionRow[] = r.report.rows.map((row) => {
    const requests = metric(row, "AD_REQUESTS");
    const matched = metric(row, "MATCHED_REQUESTS");
    const impressions = metric(row, "IMPRESSIONS");
    const clicks = metric(row, "CLICKS");
    const group = groupOf(row);
    return {
      group,
      version: label(row.dimensions[dim]),
      requests,
      matched_requests: matched,
      impressions,
      clicks,
      match_rate: ratio(matched, requests),
      show_rate: ratio(impressions, matched),
      ctr: ratio(clicks, impressions),
      request_share: ratio(requests, groupRequests.get(group) ?? 0),
      enough_data: requests >= MIN_REQUESTS,
    };
  });
  rows.sort((a, b) => (groupRequests.get(b.group) ?? 0) - (groupRequests.get(a.group) ?? 0) || a.group.localeCompare(b.group) || b.requests - a.requests);

  // Compare each version with the rest of its group, so one bad version cannot hide in its own baseline.
  const highlights: Finding[] = [];
  const noun = VERSION_NOUN[opts.by];
  // Group totals once; "the rest of the group" is the total minus the row itself.
  const totals = new Map<string, { requests: number; matched: number; impressions: number }>();
  for (const row of rows) {
    const t = totals.get(row.group) ?? { requests: 0, matched: 0, impressions: 0 };
    t.requests += row.requests;
    t.matched += row.matched_requests;
    t.impressions += row.impressions;
    totals.set(row.group, t);
  }
  for (const row of rows) {
    if (row.requests < MIN_REQUESTS || row.request_share < MIN_SHARE) continue;
    const t = totals.get(row.group)!;
    const restRequests = t.requests - row.requests;
    const restMatched = t.matched - row.matched_requests;
    const restImpressions = t.impressions - row.impressions;
    if (restRequests < MIN_REQUESTS) continue;
    const key = `${row.group} ${row.version}`;
    const traffic = `${row.requests} requests, ${pct(row.request_share)} of ${row.group}`;
    const restMatch = ratio(restMatched, restRequests);
    const restShow = ratio(restImpressions, restMatched);
    if (restMatch > 0 && row.match_rate < 0.8 * restMatch) {
      highlights.push({
        kind: "low-match-rate",
        key,
        label: key,
        message: `${key}: match rate ${pct(row.match_rate)} vs ${pct(restMatch)} on other ${row.group} ${noun}s (${traffic}).`,
      });
    }
    if (restShow > 0 && row.show_rate < 0.8 * restShow) {
      highlights.push({
        kind: "low-show-rate",
        key,
        label: key,
        message: `${key}: show rate ${pct(row.show_rate)} vs ${pct(restShow)} on other ${row.group} ${noun}s (${traffic}).`,
      });
    }
  }

  const summary = [
    `${rows.length} ${noun}s across ${groupRequests.size} ${groupDim === "APP" ? "app(s)" : "platform(s)"}, ${r.from} → ${r.to}.`,
    ...(highlights.length ? highlights.map((h) => h.message) : [`No ${noun} with enough traffic stands out on match rate or show rate.`]),
  ];
  return {
    by: opts.by,
    group_by: groupDim === "APP" ? "app" : "platform",
    from: r.from,
    to: r.to,
    timeZone: r.timeZone,
    rows,
    highlights,
    summary,
    notices: [...r.notices, ...thinDataNotice(rows.filter((x) => !x.enough_data).length, rows.length, `${noun}s`)],
  };
}

// ── consent (serving restrictions) ──────────────────────────────────

export interface ConsentOptions extends AnalyzeRange {
  app?: string;
  currency?: string;
}

export interface ConsentRow {
  /** App alias. */
  app: string;
  restriction: string;
  restriction_id: string;
  requests: number;
  /** Share of the app's ad requests. */
  request_share: number;
  earnings: number;
  earnings_micros: number;
  /** Share of the app's earnings. */
  earnings_share: number;
  impressions: number;
  ecpm: number;
  request_rpm: number;
  match_rate: number;
  show_rate: number;
  /** eCPM relative to the same app's unrestricted traffic (0.25 = a quarter of it); absent when there is none. */
  ecpm_vs_unrestricted?: number;
  /** False when this row, or the unrestricted traffic it is compared with, is below MIN_REQUESTS requests. */
  enough_data: boolean;
}

export interface ConsentApp {
  app: string;
  requests: number;
  /** Share of the app's ad requests served under any restriction; absent when it has no unrestricted traffic. */
  restricted_request_share?: number;
}

export interface ConsentResult extends Base {
  currency: string;
  estimate: true;
  /** One row per app and serving restriction, biggest app first. */
  rows: ConsentRow[];
  apps: ConsentApp[];
  /** Share of all ad requests served under any restriction. */
  restricted_request_share?: number;
}

const SERVING_RESTRICTION_START: ApiDate = { year: 2021, month: 3, day: 13 };
const UNRESTRICTED = /no restriction|unrestricted|^none$|restriction_none|no_restriction/i;

export async function analyzeConsent(svc: AdmobService, opts: ConsentOptions): Promise<ConsentResult> {
  checkRangeArgs(opts);
  // Per app: apps differ so much in eCPM that an account-wide comparison mostly measures the app mix.
  const [r, appRefs] = await Promise.all([
    fetchReport(svc, "network", {
      ...opts,
      by: ["APP", "SERVING_RESTRICTION"],
      metrics: ["ESTIMATED_EARNINGS", "AD_REQUESTS", "MATCHED_REQUESTS", "IMPRESSIONS", "CLICKS"],
      filters: opts.app ? { app: [opts.app] } : undefined,
    }),
    svc.apps(),
  ]);
  const alias = new Map(appRefs.map((a) => [a.appId, a.alias]));
  const appOf = (row: Report["rows"][number]) => alias.get(row.dimensions.APP?.value ?? "") ?? label(row.dimensions.APP);
  const totalRequests = r.report.rows.reduce((s, x) => s + metric(x, "AD_REQUESTS"), 0);
  const totalEarnings = sumMicros(r.report.rows.map((x) => metric(x, "ESTIMATED_EARNINGS")));
  const appTotals = new Map<string, { requests: number; earnings: number }>();
  for (const row of r.report.rows) {
    const t = appTotals.get(appOf(row)) ?? { requests: 0, earnings: 0 };
    t.requests += metric(row, "AD_REQUESTS");
    t.earnings += metric(row, "ESTIMATED_EARNINGS");
    appTotals.set(appOf(row), t);
  }

  const rows: ConsentRow[] = r.report.rows.map((row): ConsentRow => {
    const v = row.dimensions.SERVING_RESTRICTION;
    const app = appOf(row);
    const earnings = metric(row, "ESTIMATED_EARNINGS");
    const requests = metric(row, "AD_REQUESTS");
    const matched = metric(row, "MATCHED_REQUESTS");
    const impressions = metric(row, "IMPRESSIONS");
    return {
      app,
      restriction: label(v),
      restriction_id: v?.value ?? "",
      requests,
      request_share: ratio(requests, appTotals.get(app)!.requests),
      earnings: microsToAmount(earnings),
      earnings_micros: earnings,
      earnings_share: ratio(earnings, appTotals.get(app)!.earnings),
      impressions,
      ecpm: perMille(earnings, impressions),
      request_rpm: perMille(earnings, requests),
      match_rate: ratio(matched, requests),
      show_rate: ratio(impressions, matched),
      enough_data: requests >= MIN_REQUESTS,
    };
  });
  const appRequests = (app: string) => appTotals.get(app)!.requests;
  rows.sort((a, b) => appRequests(b.app) - appRequests(a.app) || a.app.localeCompare(b.app) || b.requests - a.requests);

  const isOpen = (x: ConsentRow) => UNRESTRICTED.test(x.restriction) || UNRESTRICTED.test(x.restriction_id);
  const highlights: Finding[] = [];
  const apps: ConsentApp[] = [];
  let openRequests = 0;
  let anyOpen = false;
  for (const [app, t] of [...appTotals].sort((a, b) => b[1].requests - a[1].requests || a[0].localeCompare(b[0]))) {
    const own = rows.filter((x) => x.app === app);
    const open = own.find(isOpen);
    apps.push({ app, requests: t.requests, ...(open ? { restricted_request_share: ratio(t.requests - open.requests, t.requests) } : {}) });
    if (!open) {
      for (const x of own) x.enough_data = false;
      continue;
    }
    anyOpen = true;
    openRequests += open.requests;
    const openEcpm = perMille(open.earnings_micros, open.impressions);
    // Compare earnings per impression from micros; the rounded eCPMs are for display only.
    const openPerImpression = ratio(open.earnings_micros, open.impressions);
    for (const x of own) {
      if (x === open) continue;
      if (open.requests < MIN_REQUESTS) x.enough_data = false;
      if (openPerImpression > 0) x.ecpm_vs_unrestricted = ratio(ratio(x.earnings_micros, x.impressions), openPerImpression);
      if (!x.enough_data || x.request_share < MIN_SHARE || x.ecpm_vs_unrestricted === undefined) continue;
      const diff = Math.round((x.ecpm_vs_unrestricted - 1) * 100);
      highlights.push({
        kind: "restricted",
        key: `${app}/${x.restriction_id}`,
        label: `${app} / ${x.restriction}`,
        message: `${app}: ${x.restriction}: ${pct(x.request_share)} of requests at eCPM ${x.ecpm.toFixed(2)} ${r.currency} vs ${openEcpm.toFixed(2)} unrestricted (${diff >= 0 ? "+" : ""}${diff}%).`,
      });
    }
  }
  const restrictedShare = anyOpen ? ratio(totalRequests - openRequests, totalRequests) : undefined;
  const money = (m: number) => `${formatMicros(m)} ${r.currency}`;
  const notices = [...r.notices];
  if (startsBefore(r.range, SERVING_RESTRICTION_START)) notices.push("Serving-restriction data starts 2021-03-13; earlier traffic is not broken down.");
  if (!anyOpen && rows.length) notices.push("No unrestricted traffic found to compare against.");
  notices.push(...thinDataNotice(rows.filter((x) => !x.enough_data).length, rows.length, "rows", ", or an unrestricted baseline that small"));

  const summary = [
    `Estimated earnings ${money(totalEarnings)} from ${totalRequests} ad requests, ${r.from} → ${r.to}.`,
    ...(restrictedShare !== undefined ? [`${pct(restrictedShare)} of ad requests were served under a restriction (consent, RDP or limited ads).`] : []),
    ...highlights.map((h) => h.message),
    ESTIMATE_LABEL,
  ];
  const result: ConsentResult = {
    from: r.from,
    to: r.to,
    currency: r.currency,
    timeZone: r.timeZone,
    estimate: true,
    rows,
    apps,
    highlights,
    summary,
    notices,
  };
  if (restrictedShare !== undefined) result.restricted_request_share = restrictedShare;
  return result;
}

// ── mediation waterfall ──────────────────────────────────────────────

export interface WaterfallOptions extends AnalyzeRange {
  app?: string;
  /** Only this mediation group (name or ID, case-insensitive). */
  group?: string;
  currency?: string;
}

export interface WaterfallRow {
  group: string;
  group_id: string;
  source: string;
  source_id: string;
  instance: string;
  instance_id: string;
  earnings: number;
  earnings_micros: number;
  /** Share of the mediation group's earnings. */
  earnings_share: number;
  requests: number;
  matched_requests: number;
  impressions: number;
  match_rate: number;
  /** Observed eCPM as reported for the ad source instance. */
  ecpm: number;
  ecpm_micros: number;
}

export interface WaterfallGroup {
  group: string;
  group_id: string;
  earnings: number;
  earnings_micros: number;
  lines: number;
}

export interface WaterfallResult extends Base {
  currency: string;
  estimate: true;
  groups: WaterfallGroup[];
  rows: WaterfallRow[];
}

export async function analyzeWaterfall(svc: AdmobService, opts: WaterfallOptions): Promise<WaterfallResult> {
  const r = await fetchReport(svc, "mediation", {
    ...opts,
    by: ["MEDIATION_GROUP", "AD_SOURCE", "AD_SOURCE_INSTANCE"],
    metrics: ["ESTIMATED_EARNINGS", "AD_REQUESTS", "MATCHED_REQUESTS", "IMPRESSIONS", "OBSERVED_ECPM"],
    filters: opts.app ? { app: [opts.app] } : undefined,
  });
  const wanted = opts.group?.trim().toLowerCase();
  const all = r.report.rows.filter((row) => {
    const g = row.dimensions.MEDIATION_GROUP;
    return !wanted || g?.value.toLowerCase() === wanted || g?.label?.toLowerCase() === wanted;
  });
  if (wanted && r.report.rows.length && !all.length) {
    const names = [...new Set(r.report.rows.map((row) => label(row.dimensions.MEDIATION_GROUP)))];
    throw usageError(`No mediation group "${opts.group}" in this period. Groups: ${names.join(", ")}`);
  }

  const groupEarnings = new Map<string, number>();
  for (const row of all) {
    const id = row.dimensions.MEDIATION_GROUP?.value ?? "";
    groupEarnings.set(id, (groupEarnings.get(id) ?? 0) + metric(row, "ESTIMATED_EARNINGS"));
  }
  const rows: WaterfallRow[] = all.map((row) => {
    const g = row.dimensions.MEDIATION_GROUP;
    const earnings = metric(row, "ESTIMATED_EARNINGS");
    const requests = metric(row, "AD_REQUESTS");
    const matched = metric(row, "MATCHED_REQUESTS");
    const ecpm = metric(row, "OBSERVED_ECPM");
    return {
      group: label(g),
      group_id: g?.value ?? "",
      source: label(row.dimensions.AD_SOURCE),
      source_id: row.dimensions.AD_SOURCE?.value ?? "",
      instance: label(row.dimensions.AD_SOURCE_INSTANCE),
      instance_id: row.dimensions.AD_SOURCE_INSTANCE?.value ?? "",
      earnings: microsToAmount(earnings),
      earnings_micros: earnings,
      earnings_share: ratio(earnings, groupEarnings.get(g?.value ?? "") ?? 0),
      requests,
      matched_requests: matched,
      impressions: metric(row, "IMPRESSIONS"),
      match_rate: ratio(matched, requests),
      ecpm: microsToAmount(ecpm),
      ecpm_micros: ecpm,
    };
  });
  const gEarn = (row: WaterfallRow) => groupEarnings.get(row.group_id) ?? 0;
  // Group ID breaks ties so groups that share a name and earnings never interleave.
  rows.sort(
    (a, b) =>
      gEarn(b) - gEarn(a) ||
      a.group.localeCompare(b.group) ||
      a.group_id.localeCompare(b.group_id) ||
      b.ecpm_micros - a.ecpm_micros ||
      b.earnings_micros - a.earnings_micros,
  );

  const groups: WaterfallGroup[] = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (last?.group_id === row.group_id) last.lines++;
    else groups.push({ group: row.group, group_id: row.group_id, earnings: microsToAmount(gEarn(row)), earnings_micros: gEarn(row), lines: 1 });
  }

  const money = (m: number) => `${formatMicros(m)} ${r.currency}`;
  const highlights: Finding[] = [];
  for (const g of groups) {
    const lines = rows.filter((x) => x.group_id === g.group_id);
    const top = lines.reduce((best, x) => (x.earnings_micros > best.earnings_micros ? x : best), lines[0]!);
    if (top.earnings_micros > 0) {
      highlights.push({
        kind: "top",
        key: `${g.group_id}/${top.instance_id}`,
        label: `${g.group} / ${top.instance}`,
        message: `${g.group}: ${top.instance} (${top.source}) earns most, ${money(top.earnings_micros)} (${pct(top.earnings_share)} of the group, observed eCPM ${top.ecpm.toFixed(2)}).`,
      });
    }
    const groupRequests = lines.reduce((s, x) => s + x.requests, 0);
    for (const x of lines) {
      if (x.requests < MIN_REQUESTS) continue;
      const key = `${g.group_id}/${x.instance_id}`;
      const name = `${g.group} / ${x.instance}`;
      if (x.impressions === 0) {
        highlights.push({ kind: "idle", key, label: name, message: `${name} (${x.source}) got ${x.requests} requests and served no ads; check its ad unit mapping or remove the line.` });
      } else if (x.match_rate < 0.02 && ratio(x.requests, groupRequests) >= MIN_SHARE) {
        highlights.push({ kind: "low-fill", key, label: name, message: `${name} (${x.source}) fills only ${pct(x.match_rate)} of ${x.requests} requests; each miss adds latency before the next line.` });
      }
    }
  }

  const total = sumMicros(rows.map((x) => x.earnings_micros));
  const summary = [
    `Estimated mediation earnings ${money(total)} across ${groups.length} mediation group(s) and ${rows.length} line(s), ${r.from} → ${r.to}.`,
    ...highlights.filter((h) => h.kind !== "top").map((h) => h.message),
    ...highlights.filter((h) => h.kind === "top").slice(0, 3).map((h) => h.message),
    "Observed eCPM for third-party sources is their own estimate.",
    ESTIMATE_LABEL,
  ];
  return {
    from: r.from,
    to: r.to,
    currency: r.currency,
    timeZone: r.timeZone,
    estimate: true,
    groups,
    rows,
    highlights,
    summary,
    notices: r.notices,
  };
}
