import type { AdSource, MediationGroup } from "./client.js";
import { usageError } from "./errors.js";
import type { AdmobService } from "./service.js";

/** Mediation groups as the MediationGroup JSON that `mediation-groups create --file` takes: for backup and cloning. */

export interface ExportGroupsOptions {
  /** Name or ID; without it every group is exported. */
  group?: string;
  /** Display name for the exported copy (one group only). */
  name?: string;
  /** Keep the AdMob Network line (left out by default, since a new group gets its own). */
  admobLine?: boolean;
}

const ADMOB_NETWORK = "admob network";

/** IDs of the ad sources titled "AdMob Network" (a new mediation group gets that line on its own). */
export function admobNetworkSourceIds(sources: AdSource[]): Set<string> {
  return new Set(sources.filter((s) => s.title.trim().toLowerCase() === ADMOB_NETWORK).map((s) => s.adSourceId));
}

export async function exportMediationGroups(svc: AdmobService, opts: ExportGroupsOptions = {}): Promise<{ groups: unknown[]; notes: string[] }> {
  if (opts.name !== undefined && !opts.group) throw usageError("--name needs a group: it renames one exported copy.");
  const [all, sources] = await Promise.all([svc.rawMediationGroups(), svc.adSources().catch((): AdSource[] | null => null)]);
  let picked = all;
  if (opts.group) {
    const q = opts.group.trim().toLowerCase();
    picked = all.filter((g) => g.mediationGroupId === opts.group!.trim() || g.displayName.toLowerCase() === q);
    if (!picked.length) throw usageError(`Unknown mediation group "${opts.group}". Groups: ${all.map((g) => g.displayName).join(", ") || "(none)"}`);
    if (picked.length > 1) throw usageError(`Mediation group name "${opts.group}" is ambiguous; use the ID: ${picked.map((g) => g.mediationGroupId).join(", ")}`);
  }
  const admob = admobNetworkSourceIds(sources ?? []);
  const notes: string[] = [];
  let droppedAdmob = 0; // groups, not lines

  const groups = picked.map((g: MediationGroup) => {
    const lines = Object.values(g.mediationGroupLines ?? {}).filter((l) => l.state !== "REMOVED");
    const treatment = lines.filter((l) => l.experimentVariant === "VARIANT_B");
    if (treatment.length) {
      notes.push(`${g.displayName} has a running A/B experiment; its ${treatment.length} treatment ${treatment.length === 1 ? "line" : "lines"} (variant B) ${treatment.length === 1 ? "was" : "were"} left out.`);
    }
    const kept = lines.filter((l) => l.experimentVariant !== "VARIANT_B" && (opts.admobLine || !admob.has(l.adSourceId)));
    if (kept.length < lines.length - treatment.length) droppedAdmob++;
    // New lines are keyed by distinct negative placeholders; IDs and output-only fields are dropped.
    const exported: Record<string, Record<string, unknown>> = {};
    kept.forEach((l, i) => {
      const line: Record<string, unknown> = {};
      if (l.displayName !== undefined) line.displayName = l.displayName;
      line.adSourceId = l.adSourceId;
      if (l.cpmMode !== undefined) line.cpmMode = l.cpmMode;
      if (l.cpmMode !== "LIVE" && l.cpmMicros !== undefined) line.cpmMicros = l.cpmMicros;
      if (l.state !== undefined) line.state = l.state;
      if (l.adUnitMappings && Object.keys(l.adUnitMappings).length) line.adUnitMappings = l.adUnitMappings;
      exported[String(-(i + 1))] = line;
    });
    const out: Record<string, unknown> = { displayName: opts.name ?? g.displayName };
    if (g.state !== undefined) out.state = g.state;
    if (g.targeting) out.targeting = g.targeting;
    out.mediationGroupLines = exported;
    return out;
  });

  if (droppedAdmob) {
    notes.push(`The AdMob Network line of ${droppedAdmob === 1 ? "1 group" : `${droppedAdmob} groups`} was left out: a new group gets its own. Pass --with-admob-line to keep it.`);
  } else if (!opts.admobLine && !sources) {
    notes.push("Ad sources could not be read, so the AdMob Network line could not be recognised and every line was kept.");
  } else if (!opts.admobLine && !admob.size) {
    notes.push('No ad source is titled "AdMob Network", so that line could not be recognised and every line was kept.');
  }
  notes.push("To create a copy: edit displayName (it must be unique), targeting.adUnitIds and each line's adUnitMappings for the target ad units, then admobctl mediation-groups create --file <file>.");
  return { groups, notes };
}
