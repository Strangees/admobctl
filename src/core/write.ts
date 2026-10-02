import { appendAudit, type AuditEntry } from "./audit.js";
import type { AdUnit, MediationGroupLine } from "./client.js";
import { AdmobctlError, usageError } from "./errors.js";
import { log } from "./log.js";
import { formatMicros } from "./money.js";
import type { AdapterView, AdmobService, MediationGroupView, MediationLineView } from "./service.js";

/**
 * Writes (AdMob API v1beta, admob.monetization scope, Google allowlisting). Every write is first built as a
 * plan, which the CLI prints; nothing is sent until applyPlan(). MCP never exposes these.
 */
export interface WritePlan {
  action: string;
  method: "POST" | "PATCH";
  /** Relative to the v1beta root, e.g. accounts/pub-1/adUnits. */
  path: string;
  query?: Record<string, string>;
  body: unknown;
  /** What will change, in plain words. */
  summary: string[];
}

/** batchCreate rejects the whole batch above this many mappings. */
export const MAPPING_BATCH_MAX = 100;

const usd = (micros: number) => `${formatMicros(micros)} USD`;

function toMicros(amount: number, what: string): string {
  if (!Number.isFinite(amount) || amount < 0.01) throw usageError(`${what} must be at least 0.01 (USD), got ${amount}`);
  return String(Math.round(amount * 1_000_000));
}

function lineMask(lineId: string, field?: string): string {
  return `mediation_group_lines["${lineId}"]${field ? `.${field}` : ""}`;
}

// ── apps and ad units ───────────────────────────────────────────────

export interface CreateAppInput {
  platform: string;
  /** Manual (unpublished) app name. */
  name?: string;
  /** App Store ID or Android package name of a published app. */
  storeId?: string;
}

export async function planCreateApp(svc: AdmobService, o: CreateAppInput): Promise<WritePlan> {
  const platform = o.platform.trim().toUpperCase();
  if (platform !== "IOS" && platform !== "ANDROID") throw usageError(`--platform must be ios or android, got "${o.platform}"`);
  if (!o.name && !o.storeId) throw usageError("Give --name or --store-id: --name for an app not in a store yet, --store-id for a published app.");
  if (o.name && o.name.length > 80) throw usageError("App names are at most 80 characters.");
  const acct = await svc.account();
  const body = o.storeId ? { platform, linkedAppInfo: { appStoreId: o.storeId } } : { platform, manualAppInfo: { displayName: o.name } };
  return {
    action: "Create app",
    method: "POST",
    path: `${acct.name}/apps`,
    body,
    summary: [`Create ${platform} app ${o.storeId ? `linked to store ID ${o.storeId}` : `"${o.name}"`} in ${acct.publisherId}.`],
  };
}

const FORMATS: Record<string, string> = {
  "app-open": "APP_OPEN",
  banner: "BANNER",
  interstitial: "INTERSTITIAL",
  native: "NATIVE",
  rewarded: "REWARDED",
  "rewarded-interstitial": "REWARDED_INTERSTITIAL",
};
const AD_TYPES: Record<string, string> = { "rich-media": "RICH_MEDIA", video: "VIDEO" };

export interface CreateAdUnitInput {
  app: string;
  name: string;
  format: string;
  adTypes?: string[];
  reward?: { amount: number; item: string };
}

export async function planCreateAdUnit(svc: AdmobService, o: CreateAdUnitInput): Promise<WritePlan> {
  const format = FORMATS[o.format.trim().toLowerCase()];
  if (!format) throw usageError(`--format must be one of ${Object.keys(FORMATS).join(", ")}, got "${o.format}"`);
  if (!o.name.trim() || o.name.length > 80) throw usageError("Ad unit names are 1 to 80 characters.");
  const adTypes = o.adTypes?.map((t) => {
    const v = AD_TYPES[t.trim().toLowerCase()];
    if (!v) throw usageError(`--ad-types takes rich-media and/or video, got "${t}"`);
    return v;
  });
  if (format === "REWARDED_INTERSTITIAL" && adTypes?.some((t) => t !== "VIDEO")) throw usageError("Rewarded interstitial ad units are video only.");
  if (format === "REWARDED" && adTypes && !adTypes.includes("VIDEO")) throw usageError("Rewarded ad units cannot exclude video.");
  if (o.reward && format !== "REWARDED") throw usageError("Reward settings apply to rewarded ad units only.");
  const app = await svc.resolveApp(o.app);
  const acct = await svc.account();
  const body: Record<string, unknown> = { appId: app.appId, displayName: o.name, adFormat: format };
  if (adTypes) body.adTypes = adTypes;
  if (o.reward) body.rewardSettings = { unitAmount: String(o.reward.amount), unitType: o.reward.item };
  return {
    action: "Create ad unit",
    method: "POST",
    path: `${acct.name}/adUnits`,
    body,
    summary: [
      `Create ${format} ad unit "${o.name}" in ${app.alias} (${app.appId})` +
        `${adTypes ? `, ad types ${adTypes.join(", ")}` : ""}${o.reward ? `, reward ${o.reward.amount} ${o.reward.item}` : ""}.`,
    ],
  };
}

// ── ad unit mappings ────────────────────────────────────────────────

export interface CreateMappingInput {
  adUnit: string;
  /** Ad source title or ID; its adapters say which settings the mapping needs. */
  adSource: string;
  /** Adapter ID or title. */
  adapter: string;
  name?: string;
  /** Setting label or ID → value. */
  settings: Record<string, string>;
}

type AdapterCache = Map<string, Promise<AdapterView[]>>;

async function mappingRequest(svc: AdmobService, o: CreateMappingInput, cache: AdapterCache) {
  const unit: AdUnit = await svc.resolveAdUnit(o.adUnit);
  const key = o.adSource.trim().toLowerCase();
  if (!cache.has(key)) cache.set(key, svc.adapters(o.adSource));
  const adapters = await cache.get(key)!;
  const adapter = adapters.find((a) => a.adapterId === o.adapter.trim() || a.title.toLowerCase() === o.adapter.trim().toLowerCase());
  if (!adapter) {
    throw usageError(`Unknown adapter "${o.adapter}" for ${adapters[0]?.adSource ?? o.adSource}. Adapters: ${adapters.map((a) => `${a.title} (${a.adapterId})`).join(", ")}`);
  }
  const app = (await svc.apps()).find((a) => a.appId === unit.appId);
  if (app && adapter.platform && adapter.platform !== app.platform) {
    throw usageError(`${adapter.title} is a ${adapter.platform} adapter, but ${unit.displayName} belongs to ${app.alias} (${app.platform}).`);
  }
  if (adapter.formats.length && !adapter.formats.includes(unit.adFormat)) {
    throw usageError(`${adapter.title} supports ${adapter.formats.join(", ")}, not ${unit.adFormat} (${unit.displayName}).`);
  }
  const config: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.settings)) {
    const setting = adapter.settings.find((s) => s.id === k || s.label.toLowerCase() === k.toLowerCase());
    if (!setting) throw usageError(`Unknown setting "${k}" for ${adapter.title}. Settings: ${adapter.settings.map((s) => s.label).join(", ")}`);
    config[setting.id] = v;
  }
  const missing = adapter.settings.filter((s) => s.required && !(s.id in config));
  if (missing.length) throw usageError(`${missing.map((s) => s.label).join(", ")} ${missing.length === 1 ? "is" : "are"} required by ${adapter.title}.`);
  const body: Record<string, unknown> = { adapterId: adapter.adapterId };
  if (o.name) body.displayName = o.name;
  body.adUnitConfigurations = config;
  return {
    parent: unit.name,
    body,
    summary: `Map ${unit.displayName} (${unit.adUnitId}) to ${adapter.title}${o.name ? ` as "${o.name}"` : ""}: ${Object.entries(o.settings).map(([k, v]) => `${k}=${v}`).join(", ")}.`,
  };
}

export async function planCreateMapping(svc: AdmobService, o: CreateMappingInput): Promise<WritePlan> {
  const r = await mappingRequest(svc, o, new Map());
  return { action: "Create ad unit mapping", method: "POST", path: `${r.parent}/adUnitMappings`, body: r.body, summary: [r.summary] };
}

/** Check a mappings file: an array of {adUnit, adSource, adapter, name?, settings}. */
export function parseMappingEntries(raw: unknown): CreateMappingInput[] {
  if (!Array.isArray(raw)) throw usageError("The mappings file must hold a JSON array of {adUnit, adSource, adapter, name?, settings}.");
  return raw.map((e, i) => {
    const where = `Mappings file entry ${i + 1}`;
    if (typeof e !== "object" || e === null) throw usageError(`${where} is not an object.`);
    const o = e as Record<string, unknown>;
    for (const k of ["adUnit", "adSource", "adapter"]) {
      if (typeof o[k] !== "string" || !o[k]) throw usageError(`${where} needs a string "${k}" (fields: adUnit, adSource, adapter, name?, settings).`);
    }
    const settings = o.settings ?? {};
    if (typeof settings !== "object" || settings === null || Array.isArray(settings) || Object.values(settings).some((v) => typeof v !== "string")) {
      throw usageError(`${where}: "settings" must map setting labels or IDs to string values.`);
    }
    const out: CreateMappingInput = { adUnit: o.adUnit as string, adSource: o.adSource as string, adapter: o.adapter as string, settings: settings as Record<string, string> };
    if (typeof o.name === "string") out.name = o.name;
    return out;
  });
}

/** One batchCreate plan per 100 mappings: the API rejects a whole batch if any mapping in it fails. */
export async function planCreateMappings(svc: AdmobService, entries: CreateMappingInput[]): Promise<WritePlan[]> {
  if (!entries.length) throw usageError("The mappings file is empty.");
  const cache: AdapterCache = new Map();
  const requests = [];
  for (const e of entries) requests.push(await mappingRequest(svc, e, cache));
  const acct = await svc.account();
  const plans: WritePlan[] = [];
  for (let i = 0; i < requests.length; i += MAPPING_BATCH_MAX) {
    const batch = requests.slice(i, i + MAPPING_BATCH_MAX);
    plans.push({
      action: "Create ad unit mappings (batch)",
      method: "POST",
      path: `${acct.name}/adUnitMappings:batchCreate`,
      body: { requests: batch.map((r) => ({ parent: r.parent, adUnitMapping: r.body })) },
      summary: [`Batch ${plans.length + 1}: ${batch.length} mapping(s), all or nothing.`, ...batch.map((r) => r.summary)],
    });
  }
  return plans;
}

// ── mediation groups ────────────────────────────────────────────────

/** Create a mediation group from the API's MediationGroup JSON (lines keyed by distinct negative IDs). */
export async function planCreateMediationGroup(svc: AdmobService, group: unknown): Promise<WritePlan> {
  if (typeof group !== "object" || group === null || Array.isArray(group)) throw usageError("The mediation group file must hold one MediationGroup JSON object.");
  const g = group as { displayName?: unknown; targeting?: { platform?: unknown; format?: unknown; adUnitIds?: unknown }; mediationGroupLines?: Record<string, unknown> };
  if (typeof g.displayName !== "string" || !g.displayName.trim()) throw usageError("displayName is required.");
  if (g.displayName.length > 120) throw usageError("displayName is at most 120 characters.");
  if (!g.targeting?.platform || !g.targeting?.format) throw usageError("targeting.platform and targeting.format are required.");
  const lineIds = Object.keys(g.mediationGroupLines ?? {});
  const bad = lineIds.filter((id) => !/^-\d+$/.test(id));
  if (bad.length) throw usageError(`New mediation lines are keyed by distinct negative placeholder IDs ("-1", "-2"…), got ${bad.join(", ")}.`);
  const acct = await svc.account();
  const units = Array.isArray(g.targeting.adUnitIds) ? g.targeting.adUnitIds.length : 0;
  return {
    action: "Create mediation group",
    method: "POST",
    path: `${acct.name}/mediationGroups`,
    body: group,
    summary: [`Create mediation group "${g.displayName}" (${String(g.targeting.platform)} ${String(g.targeting.format)}) for ${units} ad unit(s) with ${lineIds.length} line(s) besides the AdMob Network line.`],
  };
}

function resolveLine(group: MediationGroupView, input: string): MediationLineView {
  const q = input.trim().toLowerCase();
  const byId = group.lines.find((l) => l.id === input.trim());
  if (byId) return byId;
  const byName = group.lines.filter((l) => l.name.toLowerCase() === q);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) throw usageError(`Line name "${input}" is ambiguous in ${group.name}; use the line ID: ${byName.map((l) => l.id).join(", ")}`);
  throw usageError(`Unknown line "${input}" in ${group.name}. Lines: ${group.lines.map((l) => `${l.name} (${l.id})`).join(", ")}`);
}

export interface UpdateLineInput {
  group: string;
  line: string;
  /** Manual CPM in USD. */
  cpm?: number;
  state?: string;
  name?: string;
}

export async function planUpdateLine(svc: AdmobService, o: UpdateLineInput): Promise<WritePlan> {
  const group = await svc.mediationGroup(o.group);
  const line = resolveLine(group, o.line);
  const patch: Partial<MediationGroupLine> = {};
  const masks: string[] = [];
  const changes: string[] = [];
  if (o.cpm !== undefined) {
    if (line.cpmMode === "LIVE") throw usageError(`${line.name} uses LIVE CPM (bidding or optimized); only MANUAL lines take a CPM.`);
    patch.cpmMicros = toMicros(o.cpm, "--cpm");
    masks.push(lineMask(line.id, "cpm_micros"));
    changes.push(`CPM ${line.cpm_micros === undefined ? "(none)" : usd(line.cpm_micros).replace(" USD", "")} → ${usd(Number(patch.cpmMicros))}`);
  }
  if (o.state !== undefined) {
    const state = o.state.trim().toUpperCase();
    if (state !== "ENABLED" && state !== "DISABLED") throw usageError(`--state must be enabled or disabled, got "${o.state}"`);
    patch.state = state;
    masks.push(lineMask(line.id, "state"));
    changes.push(`state ${line.state} → ${state}`);
  }
  if (o.name !== undefined) {
    if (!o.name.trim() || o.name.length > 255) throw usageError("Line names are 1 to 255 characters.");
    patch.displayName = o.name;
    masks.push(lineMask(line.id, "display_name"));
    changes.push(`name "${line.name}" → "${o.name}"`);
  }
  if (!masks.length) throw usageError("Nothing to change: give --cpm, --state or --name.");
  if (group.experiment === "running") changes.push("note: this group has an A/B experiment running");
  return {
    action: "Update mediation line",
    method: "PATCH",
    path: group.resource,
    query: { updateMask: masks.join(",") },
    body: { mediationGroupLines: { [line.id]: patch } },
    summary: [`${group.name} / ${line.name} (${line.adSource}): ${changes.join("; ")}.`],
  };
}

export interface AddLineInput {
  group: string;
  adSource: string;
  name: string;
  /** Manual CPM in USD; omit for a LIVE (bidding/optimized) line. */
  cpm?: number;
  /** ad unit (name or ID) → ad unit mapping resource name */
  mappings?: Record<string, string>;
}

export async function planAddLine(svc: AdmobService, o: AddLineInput): Promise<WritePlan> {
  const group = await svc.mediationGroup(o.group);
  const source = await svc.resolveAdSource(o.adSource);
  if (!o.name.trim() || o.name.length > 255) throw usageError("Line names are 1 to 255 characters.");
  const line: Partial<MediationGroupLine> = { displayName: o.name, adSourceId: source.adSourceId, cpmMode: o.cpm === undefined ? "LIVE" : "MANUAL" };
  if (o.cpm !== undefined) line.cpmMicros = toMicros(o.cpm, "--cpm");
  line.state = "ENABLED";
  if (o.mappings && Object.keys(o.mappings).length) {
    const mappings: Record<string, string> = {};
    for (const [unit, mapping] of Object.entries(o.mappings)) mappings[(await svc.resolveAdUnit(unit)).adUnitId] = mapping;
    line.adUnitMappings = mappings;
  }
  const summary = [`Add line "${o.name}" to ${group.name}: ${source.title}, ${o.cpm === undefined ? "LIVE CPM" : `manual CPM ${usd(Number(line.cpmMicros))}`}.`];
  if (!line.adUnitMappings && !/admob network/i.test(source.title)) {
    summary.push(`Third-party lines serve only through an ad unit mapping per ad unit; add --mapping <ad-unit>=<mapping resource> (see admobctl ad-units mappings).`);
  }
  return {
    action: "Add mediation line",
    method: "PATCH",
    path: group.resource,
    query: { updateMask: lineMask("-1") },
    body: { mediationGroupLines: { "-1": line } },
    summary,
  };
}

export async function planSetGroupAdUnits(svc: AdmobService, o: { group: string; adUnits: string[] }): Promise<WritePlan> {
  if (!o.adUnits.length) throw usageError("Give at least one ad unit.");
  const group = await svc.mediationGroup(o.group);
  const ids: string[] = [];
  for (const u of o.adUnits) ids.push((await svc.resolveAdUnit(u)).adUnitId);
  const before = new Set(group.adUnits.map((u) => u.adUnitId));
  const added = ids.filter((id) => !before.has(id));
  const removed = [...before].filter((id) => !ids.includes(id));
  return {
    action: "Set mediation group ad units",
    method: "PATCH",
    path: group.resource,
    query: { updateMask: "targeting.ad_unit_ids" },
    body: { targeting: { adUnitIds: ids } },
    summary: [`${group.name} will target ${ids.length} ad unit(s) (replaces the list): +${added.length}, -${removed.length}.`, ...removed.map((id) => `removes ${id}`)],
  };
}

// ── mediation A/B experiments ───────────────────────────────────────

export interface StartExperimentInput {
  group: string;
  name: string;
  /** Share of traffic (1-99) that gets the treatment lines (variant B). */
  percent: number;
  /** The treatment's mediation lines, as MediationGroupLine JSON. */
  lines: unknown[];
}

export async function planStartExperiment(svc: AdmobService, o: StartExperimentInput): Promise<WritePlan> {
  if (!Number.isInteger(o.percent) || o.percent < 1 || o.percent > 99) throw usageError("--percent must be a whole number between 1 and 99.");
  if (!o.name.trim()) throw usageError("--name is required.");
  const group = await svc.mediationGroup(o.group);
  if (group.experiment === "running") throw usageError(`An A/B experiment is already running on ${group.name}; stop it first.`);
  if (!Array.isArray(o.lines)) throw usageError("The treatment lines file must hold a JSON array of mediation lines.");
  return {
    action: "Start mediation A/B experiment",
    method: "POST",
    path: `${group.resource}/mediationAbExperiments`,
    body: {
      displayName: o.name,
      treatmentTrafficPercentage: String(o.percent),
      treatmentMediationLines: o.lines.map((line) => ({ mediationGroupLine: line })),
    },
    summary: [`Start "${o.name}" on ${group.name}: ${o.percent}% of traffic gets ${o.lines.length} treatment line(s) (variant B); the rest keeps the current lines (A).`],
  };
}

export async function planStopExperiment(svc: AdmobService, o: { group: string; keep: string }): Promise<WritePlan> {
  const keep = o.keep.trim().toUpperCase();
  if (keep !== "A" && keep !== "B") throw usageError(`--keep must be A (the original lines) or B (the treatment), got "${o.keep}"`);
  const group = await svc.mediationGroup(o.group);
  if (group.experiment !== "running") throw usageError(`${group.name} has no A/B experiment running.`);
  return {
    action: "Stop mediation A/B experiment",
    method: "POST",
    path: `${group.resource}/mediationAbExperiments:stop`,
    body: { variantChoice: `VARIANT_CHOICE_${keep}` },
    summary: [`Stop the A/B experiment on ${group.name} and keep variant ${keep} (${keep === "A" ? "the original lines" : "the treatment lines"}).`],
  };
}

// ── apply ────────────────────────────────────────────────────────────

/** Send a plan and record it (success or failure) in the audit log. */
export async function applyPlan(svc: AdmobService, plan: WritePlan): Promise<unknown> {
  const entry = {
    time: svc.now().toISOString(),
    profile: svc.profile.name,
    action: plan.action,
    method: plan.method,
    path: plan.path,
    ...(plan.query ? { query: plan.query } : {}),
    body: plan.body,
  };
  let result: unknown;
  try {
    result = await svc.client.write(plan.method, plan.path, plan.body, plan.query);
  } catch (err) {
    audit(svc, { ...entry, ok: false, error: err instanceof AdmobctlError ? err.code : String(err) });
    throw err;
  }
  // Recorded after the write, outside its try: an audit failure must never make an applied change look failed.
  const name = (result as { name?: unknown } | undefined)?.name;
  audit(svc, { ...entry, ok: true, ...(typeof name === "string" ? { result: name } : {}) });
  return result;
}

/** Best effort: a full disk or unwritable config dir is reported, not thrown. */
function audit(svc: AdmobService, e: AuditEntry): void {
  try {
    appendAudit(svc.configDir, e);
  } catch (err) {
    log.warn(`Could not write the audit log in ${svc.configDir}: ${(err as Error).message}`);
  }
}
