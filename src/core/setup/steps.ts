import { appendAudit } from "../audit.js";
import type { TokenInfo } from "../auth/doctor.js";
import { loadConfig, resolveProfile, saveConfig, setProfileValue } from "../config.js";
import { AdmobctlError, usageError } from "../errors.js";
import type { Exec } from "../exec.js";
import type { AdmobService } from "../service.js";
import type { CloudClient, CloudProject } from "./cloud.js";
import { profileCommand } from "./commands.js";
import { apisFor, featuresFlag, featuresFromScopes, mergeFeatures, scopesFor, type Feature } from "./features.js";
import { GCLOUD_INSTALL_URL, gcloudInstalled, loginCommand, runLogin } from "./gcloud.js";

export interface SetupContext {
  svc: AdmobService;
  cloud: CloudClient;
  exec: Exec;
  /** A person at a terminal (stdin, not stdout): only then may setup run the browser sign-in or prompt. */
  interactive: boolean;
  /** Scopes of the current token; throws when there are no usable credentials. */
  tokenInfo: () => Promise<TokenInfo>;
  /** OAuth-mode sign-in (admobctl auth login), supplied by the CLI. */
  oauthLogin?: (o: { write: boolean; payments: boolean; cloudPlatform: boolean }) => Promise<void>;
}

export type StepName = "login" | "project" | "apis";

export interface StepResult {
  step: StepName;
  status: "done" | "applied" | "planned" | "needs-input";
  summary: string[];
  next_command?: string;
}

export interface LoginPlan extends StepResult {
  step: "login";
  features: Feature[];
  scopes: string[];
}

export interface ProjectPlan extends StepResult {
  step: "project";
  project?: string;
  projects?: CloudProject[];
}

export interface ApisPlan extends StepResult {
  step: "apis";
  project?: string;
  services: string[];
}

// The profile is re-read from disk, so a step sees what an earlier step in the same run stored.
const profileNow = (ctx: SetupContext) => resolveProfile(loadConfig(ctx.svc.configDir), ctx.svc.profile.name);
const commandFor = (ctx: SetupContext, command: string) => profileCommand(command, ctx.svc.profile.name, loadConfig(ctx.svc.configDir).defaultProfile);
const quotaProjectNow = (ctx: SetupContext) => profileNow(ctx).quotaProject ?? ctx.svc.tokenProvider.quotaProject();

function store(ctx: SetupContext, key: string, value: string): void {
  const cfg = loadConfig(ctx.svc.configDir);
  setProfileValue(cfg, ctx.svc.profile.name, key, value);
  saveConfig(ctx.svc.configDir, cfg);
}

/** Features to set up: always read, plus stored, already granted and requested ones (a fix never drops a scope). */
export async function planLogin(ctx: SetupContext, requested: Feature[]): Promise<LoginPlan> {
  // A credentials problem whose fix is a manual step (credentials selected by GOOGLE_APPLICATION_CREDENTIALS, a locked
  // keychain) cannot be fixed by a browser sign-in: surface it before opening one.
  try {
    await ctx.svc.tokenProvider.checkCredentials?.();
  } catch (err) {
    if (err instanceof AdmobctlError && err.fix && !err.fix.startsWith("admobctl ")) throw err;
  }
  let granted: string[] | undefined;
  try {
    granted = (await ctx.tokenInfo()).scopes;
  } catch {
    granted = undefined;
  }
  const features = mergeFeatures(["read"], profileNow(ctx).features ?? [], granted ? featuresFromScopes(granted) : [], requested);
  const scopes = scopesFor(features);
  if (granted && scopes.every((s) => granted!.includes(s))) {
    return { step: "login", status: "done", features, scopes, summary: [`Signed in with the scopes for: ${features.join(", ")}`] };
  }
  const lacking = granted ? `Your sign-in lacks scopes: ${scopes.filter((s) => !granted!.includes(s)).map((s) => s.split("/").pop()).join(", ")}` : "Not signed in.";
  const blocked = ctx.svc.tokenProvider.signInBlocked?.();
  if (blocked) {
    throw new AdmobctlError(granted ? "AUTH_SCOPE_MISSING" : "AUTH_NO_CREDENTIALS", `${lacking.replace(/\.$/, "")}, and GOOGLE_APPLICATION_CREDENTIALS selects credentials that a gcloud sign-in does not replace.`, {
      fix: blocked,
    });
  }
  const how =
    ctx.svc.tokenProvider.mode === "oauth"
      ? `Sign in with your own OAuth client: ${commandFor(ctx, `admobctl auth login${features.includes("write") ? " --write" : ""}${features.includes("payments") ? " --payments" : ""} --cloud-platform`)}`
      : `Sign in with gcloud (it opens your browser): ${loginCommand(scopes)}`;
  return {
    step: "login",
    status: "planned",
    features,
    scopes,
    summary: [lacking, how, ...(ctx.svc.tokenProvider.mode === "adc" ? [`Requires Google Cloud CLI (gcloud): ${GCLOUD_INSTALL_URL}`] : [])],
    next_command: commandFor(ctx, `admobctl setup login${featuresFlag(features)} --yes`),
  };
}

export async function applyLogin(ctx: SetupContext, plan: LoginPlan): Promise<LoginPlan> {
  if (plan.status === "planned") {
    if (!ctx.interactive) {
      throw new AdmobctlError("USAGE", `The Google sign-in opens a browser, so it must run in a terminal. Run this in a terminal: ${ctx.svc.tokenProvider.mode === "oauth" ? plan.next_command : loginCommand(plan.scopes)}`, {
        fix: plan.next_command,
      });
    }
    if (ctx.svc.tokenProvider.mode === "oauth") {
      if (!ctx.oauthLogin) throw usageError("OAuth sign-in is only available from the CLI: admobctl setup login --yes");
      await ctx.oauthLogin({ write: plan.features.includes("write"), payments: plan.features.includes("payments"), cloudPlatform: true });
    } else {
      if (!(await gcloudInstalled(ctx.exec))) {
        throw new AdmobctlError("AUTH_NO_CREDENTIALS", `The Google Cloud CLI (gcloud) is needed for the sign-in. Install it from ${GCLOUD_INSTALL_URL}, then run the fix.`, {
          fix: plan.next_command,
        });
      }
      await runLogin(ctx.exec, plan.scopes);
    }
    ctx.svc.tokenProvider.resetCache?.();
  }
  store(ctx, "features", plan.features.join(","));
  return { ...plan, status: plan.status === "planned" ? "applied" : plan.status };
}

export async function planProject(ctx: SetupContext, id?: string): Promise<ProjectPlan> {
  const current = quotaProjectNow(ctx);
  if (!id) {
    if (!current && ctx.svc.tokenProvider.mode === "oauth") {
      return { step: "project", status: "done", summary: ["A quota project is not required for your own OAuth client."] };
    }
    if (current) return { step: "project", status: "done", project: current, summary: [`Quota project: ${current}`] };
    const projects = await ctx.cloud.listProjects();
    return {
      step: "project",
      status: "needs-input",
      projects,
      summary: projects.length
        ? ["Choose the Google Cloud project to use for API quota:", ...projects.slice(0, 10).map((p) => `  ${p.projectId}  (${p.name})`)]
        : ["You have no Google Cloud project. Create one at https://console.cloud.google.com/projectcreate, then use its ID below."],
      next_command: commandFor(ctx, "admobctl setup project use <project-id> --yes"),
    };
  }
  if (id === current) return { step: "project", status: "done", project: id, summary: [`Quota project: ${id}`] };
  const p = await ctx.cloud.getProject(id);
  return {
    step: "project",
    status: "planned",
    project: p.projectId,
    summary: [`Use ${p.projectId} (${p.name}) as the quota project for this profile.`],
    next_command: commandFor(ctx, `admobctl setup project use ${p.projectId} --yes`),
  };
}

export async function applyProject(ctx: SetupContext, plan: ProjectPlan): Promise<ProjectPlan> {
  if (plan.status !== "planned" || !plan.project) return plan;
  store(ctx, "quotaProject", plan.project);
  return { ...plan, status: "applied" };
}

export async function planApis(ctx: SetupContext, requested: Feature[], targetProject?: string): Promise<ApisPlan> {
  const features = mergeFeatures(["read"], profileNow(ctx).features ?? [], requested);
  const project = targetProject ?? quotaProjectNow(ctx);
  if (!project && ctx.svc.tokenProvider.mode === "oauth") {
    return { step: "apis", status: "done", services: [], summary: [`API enablement belongs to your OAuth client project. Run ${commandFor(ctx, "admobctl setup status")} to probe API access; to manage enablement explicitly, run ${commandFor(ctx, "admobctl setup apis --project <client-project-id>")}.`] };
  }
  if (!project) {
    return { step: "apis", status: "needs-input", services: [], summary: ["No quota project yet; choose one first."], next_command: commandFor(ctx, "admobctl setup project list") };
  }
  const states = await ctx.cloud.serviceStates(project, apisFor(features));
  const off = apisFor(features).filter((s) => states[s] !== "ENABLED");
  if (!off.length) return { step: "apis", status: "done", project, services: [], summary: [`Enabled in ${project}: ${apisFor(features).join(", ")}`] };
  return {
    step: "apis",
    status: "planned",
    project,
    services: off,
    summary: [`Enable ${off.join(", ")} in ${project}.`],
    next_command: commandFor(ctx, `admobctl setup apis${featuresFlag(features)}${targetProject ? ` --project ${targetProject}` : ""} --yes`),
  };
}

export async function applyApis(ctx: SetupContext, plan: ApisPlan): Promise<ApisPlan> {
  if (plan.status !== "planned" || !plan.project) return plan;
  const entry = {
    time: new Date().toISOString(),
    profile: ctx.svc.profile.name,
    action: "Enable APIs",
    method: "POST",
    path: `projects/${plan.project}/services:batchEnable`,
    body: { serviceIds: plan.services },
  };
  try {
    await ctx.cloud.enableServices(plan.project, plan.services);
  } catch (err) {
    appendAudit(ctx.svc.configDir, { ...entry, ok: false, error: (err as Error).message });
    throw err;
  }
  appendAudit(ctx.svc.configDir, { ...entry, ok: true });
  return { ...plan, status: "applied", summary: [...plan.summary, "Enabled. Google may take a minute to apply it everywhere."] };
}

export interface SetupRun {
  steps: StepResult[];
  next_command?: string;
}

/** Guided setup: login → project → apis. Applies only with yes; stops at the first step that needs the user. */
export async function runSetup(ctx: SetupContext, o: { features: Feature[]; project?: string; yes: boolean }): Promise<SetupRun> {
  const steps: StepResult[] = [];
  const stop = (s: StepResult): SetupRun => ({ steps: [...steps, s], ...(s.next_command ? { next_command: s.next_command } : {}) });

  const login = await planLogin(ctx, o.features);
  if (login.status === "planned") {
    if (!o.yes) return stop(login);
    if (!ctx.interactive) {
      return stop({ ...login, status: "needs-input", summary: [...login.summary, "The sign-in opens a browser: run the command above in a terminal."] });
    }
  }
  steps.push(o.yes ? await applyLogin(ctx, login) : login);

  const project = await planProject(ctx, o.project);
  if (project.status === "needs-input" || (project.status === "planned" && !o.yes)) return stop(project);
  steps.push(await applyProject(ctx, project));

  const apis = await planApis(ctx, login.features);
  if (apis.status === "needs-input" || (apis.status === "planned" && !o.yes)) return stop(apis);
  steps.push(await applyApis(ctx, apis));
  return { steps };
}
