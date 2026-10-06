import { fetchTokenInfo, runDoctor, type Check } from "../auth/doctor.js";
import type { AdmobService } from "../service.js";
import { loadConfig } from "../config.js";
import { profileCommand } from "./commands.js";
import { CloudClient } from "./cloud.js";
import { apisFor, parseFeatures } from "./features.js";

export interface SetupStatus {
  ok: boolean;
  checks: Check[];
  /** The one command to run next: the first failing check's fix_command, else the first warning's. */
  next_command?: string;
}

/** Every setup check (credentials, scopes per feature, quota project, APIs, account, apps, v1beta), each with its fix. */
export async function setupStatus(svc: AdmobService, deps: { fetch?: typeof fetch } = {}): Promise<SetupStatus> {
  const tp = svc.tokenProvider;
  const features = parseFeatures(svc.profile.features);
  const quotaProject = svc.profile.quotaProject ?? tp.quotaProject();
  const cloud = new CloudClient({ getToken: () => tp.getToken(), fetch: deps.fetch });
  const checks = await runDoctor({
    mode: tp.mode,
    checkCredentials: () => tp.checkCredentials?.(),
    getToken: () => tp.getToken(),
    tokenInfo: (t) => fetchTokenInfo(t, deps.fetch),
    quotaProject,
    features,
    serviceStates: quotaProject ? () => cloud.serviceStates(quotaProject, apisFor(features)) : undefined,
    listAccounts: () => svc.listAccounts(),
    account: () => svc.account(),
    listApps: () => svc.apps(),
    betaProbes: { "ad sources": () => svc.adSources(), "mediation groups": () => svc.mediationGroups() },
  });
  const configuredDefault = loadConfig(svc.configDir).defaultProfile;
  for (const check of checks) {
    if (check.fix) check.fix = profileCommand(check.fix, svc.profile.name, configuredDefault);
    if (check.fix_command) check.fix_command = profileCommand(check.fix_command, svc.profile.name, configuredDefault);
  }
  const next =
    checks.find((c) => c.status === "fail" && c.fix_command)?.fix_command ?? checks.find((c) => c.status === "warn" && c.fix_command)?.fix_command;
  return { ok: checks.every((c) => c.status !== "fail"), checks, ...(next ? { next_command: next } : {}) };
}
