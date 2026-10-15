import { AdmobctlError, usageError } from "../errors.mjs";
import { apisFor, featuresFlag, featuresFromScopes, mergeFeatures, scopesFor } from "./features.mjs";
import { loadConfig, resolveProfile, saveConfig, setProfileValue } from "../config.mjs";
import { profileCommand } from "./commands.mjs";
import { appendAudit } from "../audit.mjs";
import { GCLOUD_INSTALL_URL, gcloudInstalled, loginCommand, runLogin } from "./gcloud.mjs";

//#region src/core/setup/steps.ts
const profileNow = (ctx) => resolveProfile(loadConfig(ctx.svc.configDir), ctx.svc.profile.name);
const commandFor = (ctx, command) => profileCommand(command, ctx.svc.profile.name, loadConfig(ctx.svc.configDir).defaultProfile);
const quotaProjectNow = (ctx) => profileNow(ctx).quotaProject ?? ctx.svc.tokenProvider.quotaProject();
function store(ctx, key, value) {
	const cfg = loadConfig(ctx.svc.configDir);
	setProfileValue(cfg, ctx.svc.profile.name, key, value);
	saveConfig(ctx.svc.configDir, cfg);
}
/** Features to set up: always read, plus stored, already granted and requested ones (a fix never drops a scope). */
async function planLogin(ctx, requested) {
	try {
		await ctx.svc.tokenProvider.checkCredentials?.();
	} catch (err) {
		if (err instanceof AdmobctlError && err.code === "AUTH_SERVICE_ACCOUNT" && !err.fix?.startsWith("admobctl ")) throw err;
	}
	let granted;
	try {
		granted = (await ctx.tokenInfo()).scopes;
	} catch {
		granted = void 0;
	}
	const features = mergeFeatures(["read"], profileNow(ctx).features ?? [], granted ? featuresFromScopes(granted) : [], requested);
	const scopes = scopesFor(features);
	if (granted && scopes.every((s) => granted.includes(s))) return {
		step: "login",
		status: "done",
		features,
		scopes,
		summary: [`Signed in with the scopes for: ${features.join(", ")}`]
	};
	const how = ctx.svc.tokenProvider.mode === "oauth" ? `Sign in with your own OAuth client: ${commandFor(ctx, `admobctl auth login${features.includes("write") ? " --write" : ""}${features.includes("payments") ? " --payments" : ""} --cloud-platform`)}` : `Sign in with gcloud (it opens your browser): ${loginCommand(scopes)}`;
	return {
		step: "login",
		status: "planned",
		features,
		scopes,
		summary: [
			granted ? `Your sign-in lacks scopes: ${scopes.filter((s) => !granted.includes(s)).map((s) => s.split("/").pop()).join(", ")}` : "Not signed in.",
			how,
			...ctx.svc.tokenProvider.mode === "adc" ? [`Requires Google Cloud CLI (gcloud): ${GCLOUD_INSTALL_URL}`] : []
		],
		next_command: commandFor(ctx, `admobctl setup login${featuresFlag(features)} --yes`)
	};
}
async function applyLogin(ctx, plan) {
	if (plan.status === "planned") {
		if (!ctx.interactive) throw new AdmobctlError("USAGE", `The Google sign-in opens a browser, so it must run in a terminal. Run this in a terminal: ${ctx.svc.tokenProvider.mode === "oauth" ? plan.next_command : loginCommand(plan.scopes)}`, { fix: plan.next_command });
		if (ctx.svc.tokenProvider.mode === "oauth") {
			if (!ctx.oauthLogin) throw usageError("OAuth sign-in is only available from the CLI: admobctl setup login --yes");
			await ctx.oauthLogin({
				write: plan.features.includes("write"),
				payments: plan.features.includes("payments"),
				cloudPlatform: true
			});
		} else {
			if (!await gcloudInstalled(ctx.exec)) throw new AdmobctlError("AUTH_NO_CREDENTIALS", `The Google Cloud CLI (gcloud) is needed for the sign-in. Install it from ${GCLOUD_INSTALL_URL}, then run the fix.`, { fix: plan.next_command });
			await runLogin(ctx.exec, plan.scopes);
		}
		ctx.svc.tokenProvider.resetCache?.();
	}
	store(ctx, "features", plan.features.join(","));
	return {
		...plan,
		status: plan.status === "planned" ? "applied" : plan.status
	};
}
async function planProject(ctx, id) {
	const current = quotaProjectNow(ctx);
	if (!id) {
		if (!current && ctx.svc.tokenProvider.mode === "oauth") return {
			step: "project",
			status: "done",
			summary: ["A quota project is not required for your own OAuth client."]
		};
		if (current) return {
			step: "project",
			status: "done",
			project: current,
			summary: [`Quota project: ${current}`]
		};
		const projects = await ctx.cloud.listProjects();
		return {
			step: "project",
			status: "needs-input",
			projects,
			summary: projects.length ? ["Choose the Google Cloud project to use for API quota:", ...projects.slice(0, 10).map((p) => `  ${p.projectId}  (${p.name})`)] : ["You have no Google Cloud project. Create one at https://console.cloud.google.com/projectcreate, then use its ID below."],
			next_command: commandFor(ctx, "admobctl setup project use <project-id> --yes")
		};
	}
	if (id === current) return {
		step: "project",
		status: "done",
		project: id,
		summary: [`Quota project: ${id}`]
	};
	const p = await ctx.cloud.getProject(id);
	return {
		step: "project",
		status: "planned",
		project: p.projectId,
		summary: [`Use ${p.projectId} (${p.name}) as the quota project for this profile.`],
		next_command: commandFor(ctx, `admobctl setup project use ${p.projectId} --yes`)
	};
}
async function applyProject(ctx, plan) {
	if (plan.status !== "planned" || !plan.project) return plan;
	store(ctx, "quotaProject", plan.project);
	return {
		...plan,
		status: "applied"
	};
}
async function planApis(ctx, requested, targetProject) {
	const features = mergeFeatures(["read"], profileNow(ctx).features ?? [], requested);
	const project = targetProject ?? quotaProjectNow(ctx);
	if (!project && ctx.svc.tokenProvider.mode === "oauth") return {
		step: "apis",
		status: "done",
		services: [],
		summary: [`API enablement belongs to your OAuth client project. Run ${commandFor(ctx, "admobctl setup status")} to probe API access; to manage enablement explicitly, run ${commandFor(ctx, "admobctl setup apis --project <client-project-id>")}.`]
	};
	if (!project) return {
		step: "apis",
		status: "needs-input",
		services: [],
		summary: ["No quota project yet; choose one first."],
		next_command: commandFor(ctx, "admobctl setup project list")
	};
	const states = await ctx.cloud.serviceStates(project, apisFor(features));
	const off = apisFor(features).filter((s) => states[s] !== "ENABLED");
	if (!off.length) return {
		step: "apis",
		status: "done",
		project,
		services: [],
		summary: [`Enabled in ${project}: ${apisFor(features).join(", ")}`]
	};
	return {
		step: "apis",
		status: "planned",
		project,
		services: off,
		summary: [`Enable ${off.join(", ")} in ${project}.`],
		next_command: commandFor(ctx, `admobctl setup apis${featuresFlag(features)}${targetProject ? ` --project ${targetProject}` : ""} --yes`)
	};
}
async function applyApis(ctx, plan) {
	if (plan.status !== "planned" || !plan.project) return plan;
	const entry = {
		time: (/* @__PURE__ */ new Date()).toISOString(),
		profile: ctx.svc.profile.name,
		action: "Enable APIs",
		method: "POST",
		path: `projects/${plan.project}/services:batchEnable`,
		body: { serviceIds: plan.services }
	};
	try {
		await ctx.cloud.enableServices(plan.project, plan.services);
	} catch (err) {
		appendAudit(ctx.svc.configDir, {
			...entry,
			ok: false,
			error: err.message
		});
		throw err;
	}
	appendAudit(ctx.svc.configDir, {
		...entry,
		ok: true
	});
	return {
		...plan,
		status: "applied",
		summary: [...plan.summary, "Enabled. Google may take a minute to apply it everywhere."]
	};
}
/** Guided setup: login → project → apis. Applies only with yes; stops at the first step that needs the user. */
async function runSetup(ctx, o) {
	const steps = [];
	const stop = (s) => ({
		steps: [...steps, s],
		...s.next_command ? { next_command: s.next_command } : {}
	});
	const login = await planLogin(ctx, o.features);
	if (login.status === "planned") {
		if (!o.yes) return stop(login);
		if (!ctx.interactive) return stop({
			...login,
			status: "needs-input",
			summary: [...login.summary, "The sign-in opens a browser: run the command above in a terminal."]
		});
	}
	steps.push(o.yes ? await applyLogin(ctx, login) : login);
	const project = await planProject(ctx, o.project);
	if (project.status === "needs-input" || project.status === "planned" && !o.yes) return stop(project);
	steps.push(await applyProject(ctx, project));
	const apis = await planApis(ctx, login.features);
	if (apis.status === "needs-input" || apis.status === "planned" && !o.yes) return stop(apis);
	steps.push(await applyApis(ctx, apis));
	return { steps };
}

//#endregion
export { applyApis, applyLogin, applyProject, planApis, planLogin, planProject, runSetup };