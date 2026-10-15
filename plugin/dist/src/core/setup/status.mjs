import { apisFor, parseFeatures } from "./features.mjs";
import { fetchTokenInfo, runDoctor } from "../auth/doctor.mjs";
import { CloudClient } from "./cloud.mjs";
import { loadConfig } from "../config.mjs";
import { profileCommand } from "./commands.mjs";

//#region src/core/setup/status.ts
/** Every setup check (credentials, scopes per feature, quota project, APIs, account, apps, v1beta), each with its fix. */
async function setupStatus(svc, deps = {}) {
	const tp = svc.tokenProvider;
	const features = parseFeatures(svc.profile.features);
	const quotaProject = svc.profile.quotaProject ?? tp.quotaProject();
	const cloud = new CloudClient({
		getToken: () => tp.getToken(),
		fetch: deps.fetch
	});
	const checks = await runDoctor({
		mode: tp.mode,
		checkCredentials: () => tp.checkCredentials?.(),
		getToken: () => tp.getToken(),
		tokenInfo: (t) => fetchTokenInfo(t, deps.fetch),
		quotaProject,
		features,
		serviceStates: quotaProject ? () => cloud.serviceStates(quotaProject, apisFor(features)) : void 0,
		listAccounts: () => svc.listAccounts(),
		account: () => svc.account(),
		listApps: () => svc.apps(),
		betaProbes: {
			"ad sources": () => svc.adSources(),
			"mediation groups": () => svc.mediationGroups()
		}
	});
	const configuredDefault = loadConfig(svc.configDir).defaultProfile;
	for (const check of checks) {
		if (check.fix) check.fix = profileCommand(check.fix, svc.profile.name, configuredDefault);
		if (check.fix_command) check.fix_command = profileCommand(check.fix_command, svc.profile.name, configuredDefault);
	}
	const next = checks.find((c) => c.status === "fail" && c.fix_command)?.fix_command ?? checks.find((c) => c.status === "warn" && c.fix_command)?.fix_command;
	return {
		ok: checks.every((c) => c.status !== "fail"),
		checks,
		...next ? { next_command: next } : {}
	};
}

//#endregion
export { setupStatus };