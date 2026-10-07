import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { Command, CommanderError, Option } from "commander";
import { fetchTokenInfo } from "../core/auth/doctor.js";
import { exec as defaultExec } from "../core/exec.js";
import { CloudClient } from "../core/setup/cloud.js";
import { parseFeatures } from "../core/setup/features.js";
import { setupStatus } from "../core/setup/status.js";
import { profileCommand } from "../core/setup/commands.js";
import {
  applyApis,
  applyLogin,
  applyProject,
  planApis,
  planLogin,
  planProject,
  runSetup,
  type SetupContext,
  type SetupRun,
  type StepResult,
} from "../core/setup/steps.js";
import { login, logout } from "../core/auth/login.js";
import { defaultSecretStore, type StoredOAuth } from "../core/auth/oauth.js";
import { configDir, configPath, loadConfig, resolveProfile, saveConfig, setProfileValue } from "../core/config.js";
import { analyzeConsent, analyzeVersions, analyzeWaterfall, VERSION_KINDS, type VersionKind } from "../core/analyze.js";
import { checkAppAds } from "../core/app-ads.js";
import { readAudit } from "../core/audit.js";
import { check } from "../core/check.js";
import { AdmobctlError } from "../core/errors.js";
import { financeForecast, financeMonth, financeRange, journalRows } from "../core/finance.js";
import { financeBalance } from "../core/payments.js";
import { EXPORT_FORMATS, exportJournal } from "../core/journal.js";
import { analyzeGeo } from "../core/geo.js";
import { INSIGHT_DIMENSIONS, insights, type InsightDimension } from "../core/insights.js";
import { lint } from "../core/lint.js";
import { exportMediationGroups } from "../core/mediation-export.js";
import { log } from "../core/log.js";
import {
  applyPlan,
  parseMappingEntries,
  planAddLine,
  planCreateAdUnit,
  planCreateApp,
  planCreateMapping,
  planCreateMappings,
  planCreateMediationGroup,
  planSetGroupAdUnits,
  planStartExperiment,
  planStopExperiment,
  planUpdateLine,
  type WritePlan,
} from "../core/write.js";
import { AdmobService, COMPARISONS, type ServiceDeps, type ServiceOptions } from "../core/service.js";
import { defaultFormat, OUTPUT_FORMATS, render, renderTsv, type Output, type OutputFormat } from "../output/format.js";
import { analyzeTrend, TREND_SPLITS, type TrendSplit } from "../core/trend.js";
import { VERSION } from "../version.js";
import {
  accountsView,
  adaptersView,
  adSourcesView,
  adUnitsView,
  appAdsView,
  appsView,
  auditLogView,
  checkView,
  consentView,
  projectsView,
  setupStatusView,
  setupStepsView,
  financeBalanceView,
  financeForecastView,
  financeMonthView,
  financeRangeView,
  geoView,
  insightsView,
  journalView,
  keyValueView,
  lintView,
  mappingsView,
  mediationGroupsView,
  mediationGroupView,
  reportView,
  trendView,
  versionsView,
  waterfallView,
  writeView,
} from "./views.js";

export interface CliIO {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  /** stdout is a terminal: picks the default output format (table, else JSON). */
  isTTY: boolean;
  /** stdin is a terminal: a person can complete the interactive sign-in. Default false. */
  stdinIsTTY?: boolean;
  service?: ServiceDeps;
  /**
   * Starts the MCP server for `admobctl mcp`. Injected by the composition root (src/bin.ts) so that
   * src/cli never imports src/mcp. The CLI hands over a service factory bound to the global flags.
   */
  runMcp?: (deps: { service: (opts: ServiceOptions) => AdmobService }) => Promise<void>;
}

interface GlobalOpts {
  output?: OutputFormat;
  profile?: string;
  account?: string;
  verbose?: boolean;
}

const list = (v: string, prev: string[] = []) => [...prev, ...v.split(",").map((s) => s.trim()).filter(Boolean)];

function parseFilters(values: string[] = []): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const f of values) {
    const eq = f.indexOf("=");
    if (eq <= 0) throw new AdmobctlError("USAGE", `--filter expects key=value[,value…], got "${f}"`);
    const key = f.slice(0, eq).trim();
    (out[key] ??= []).push(...list(f.slice(eq + 1)));
  }
  return out;
}

function parseDays(v: string, flag = "--last"): number {
  const m = /^(\d+)d$/.exec(v.trim());
  if (!m) throw new AdmobctlError("USAGE", `${flag} expects a number of days like 30d, got "${v}"`);
  return Number(m[1]);
}

function readJsonFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new AdmobctlError("USAGE", `Cannot read ${path}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new AdmobctlError("USAGE", `${path} is not valid JSON: ${(err as Error).message}`);
  }
}

/** "Label=value" pairs from repeated --set / --mapping options. */
function parsePairs(values: string[] = [], flag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of values) {
    const eq = v.indexOf("=");
    if (eq <= 0) throw new AdmobctlError("USAGE", `${flag} expects key=value, got "${v}"`);
    out[v.slice(0, eq).trim()] = v.slice(eq + 1).trim();
  }
  return out;
}

function positiveAmount(v: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new AdmobctlError("USAGE", `Expected a positive amount, got "${v}"`);
  return n;
}

function positiveInt(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new AdmobctlError("USAGE", `Expected a positive integer, got "${v}"`);
  return n;
}

export function buildProgram(io: CliIO): Command {
  const program = new Command("admobctl");
  const g = (cmd: Command) => cmd.optsWithGlobals<GlobalOpts>();
  const svc = (cmd: Command) => AdmobService.create({ profile: g(cmd).profile, account: g(cmd).account }, io.service);
  const dir = () => io.service?.configDir ?? configDir();
  const emit = (cmd: Command, out: Output) => io.stdout(render(out, g(cmd).output ?? defaultFormat(io.isTTY)));
  const repeat = (v: string, p: string[] = []) => [...p, v];
  /** Writes are dry runs unless --yes: print the plan, or apply each plan in order and print what the API returned. */
  const runWrite = async (cmd: Command, s: AdmobService, plans: WritePlan[], yes: boolean | undefined) => {
    if (!yes) {
      emit(cmd, writeView(plans));
      io.stderr("Dry run: nothing was sent. Re-run with --yes to apply.\n");
      return;
    }
    const results: unknown[] = [];
    for (const [i, plan] of plans.entries()) {
      try {
        results.push(await applyPlan(s, plan));
      } catch (err) {
        if (i > 0) io.stderr(`Applied ${i} of ${plans.length} steps before this failure (see ${s.configDir}/audit.log).\n`);
        throw err;
      }
    }
    emit(cmd, writeView(plans, results));
  };
  const yesOption = () => new Option("--yes", "apply the change (without it, only print what would be sent)");

  program
    .description("Fast CLI for the Google AdMob API (unofficial, not affiliated with Google)")
    .version(VERSION, "-V, --version")
    .addOption(new Option("-o, --output <format>", "output format (default: table on a TTY, json when piped)").choices(OUTPUT_FORMATS))
    .option("--profile <name>", "config profile to use")
    .option("--account <pub-id>", "AdMob publisher ID (pub-…)")
    .option("-v, --verbose", "debug logging to stderr")
    .hook("preAction", (cmd) => log.setVerbose(Boolean(cmd.opts<GlobalOpts>().verbose)))
    .showHelpAfterError("(run with --help for usage)")
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr })
    .exitOverride();

  /** Own-OAuth-client sign-in, shared by auth login and setup login in OAuth mode. */
  const oauthSignIn = async (cmd: Command, o: { clientId?: string; clientSecret?: string; write?: boolean; payments?: boolean; cloudPlatform?: boolean }) => {
    const profileName = g(cmd).profile ?? loadConfig(dir()).defaultProfile ?? "default";
    const clientId = o.clientId ?? resolveProfile(loadConfig(dir()), g(cmd).profile).oauthClientId;
    if (!clientId) {
      throw new AdmobctlError("USAGE", "An OAuth client ID is required.", {
        fix: "Create a Desktop app OAuth client in Google Cloud Console (APIs & Services → Credentials), then: admobctl auth login --client-id <id> --client-secret <secret>",
      });
    }
    const store = defaultSecretStore(dir(), io.service?.exec);
    let saved: StoredOAuth | undefined;
    const raw = await store.get(profileName);
    if (raw) {
      try { saved = JSON.parse(raw) as StoredOAuth; } catch { /* A new sign-in can repair corrupt credentials. */ }
    }
    const r = await login({
      configDir: dir(),
      profile: profileName,
      clientId,
      clientSecret: o.clientSecret ?? process.env.ADMOBCTL_OAUTH_CLIENT_SECRET ?? (saved?.clientId === clientId ? saved.clientSecret : undefined),
      store,
      fetch: io.service?.fetch,
      print: io.stderr,
      write: o.write,
      payments: o.payments,
      cloudPlatform: o.cloudPlatform,
    });
    io.stderr(`Signed in. Profile "${r.profile}" now uses admobctl OAuth. Run: ${profileCommand("admobctl setup status", profileName, loadConfig(dir()).defaultProfile)}\n`);
  };
  const setupCtx = (cmd: Command): SetupContext => {
    const s = svc(cmd);
    const tp = s.tokenProvider;
    return {
      svc: s,
      cloud: new CloudClient({ getToken: () => tp.getToken(), fetch: io.service?.fetch, sleep: io.service?.sleep }),
      exec: io.service?.exec ?? defaultExec,
      interactive: io.stdinIsTTY ?? false,
      tokenInfo: async () => fetchTokenInfo(await tp.getToken(), io.service?.fetch),
      oauthLogin: (o) => oauthSignIn(cmd, o),
    };
  };
  const emitSetup = (cmd: Command, r: SetupRun) => {
    emit(cmd, setupStepsView(r));
    const last = r.steps[r.steps.length - 1];
    if (last?.status === "planned") io.stderr("Dry run: nothing changed.\n");
    if (r.next_command) io.stderr(`Next: ${r.next_command}\n`);
    else if (r.steps.every((x) => x.status === "done" || x.status === "applied")) io.stderr("Setup steps complete. Check everything with: admobctl setup status\n");
  };
  const runStep = async <P extends StepResult>(cmd: Command, plan: P, yes: boolean | undefined, apply: (p: P) => Promise<P>) => {
    const r = yes ? await apply(plan) : plan;
    const pending = r.status === "planned" || r.status === "needs-input";
    emitSetup(cmd, { steps: [r], ...(pending && r.next_command ? { next_command: r.next_command } : {}) });
  };
  const emitStatus = async (cmd: Command) => {
    const st = await setupStatus(svc(cmd), { fetch: io.service?.fetch });
    emit(cmd, setupStatusView(st));
    if (st.next_command) io.stderr(`Next: ${st.next_command}\n`);
    if (!st.ok) process.exitCode = 1;
  };

  // ── auth ──────────────────────────────────────────────────────────
  const auth = program.command("auth").description("Authenticate and diagnose credentials");

  auth
    .command("login")
    .description("Sign in with your own OAuth client (Desktop app) instead of gcloud ADC")
    .option("--client-id <id>", "OAuth client ID (Desktop app) from Google Cloud Console")
    .option("--client-secret <secret>", "OAuth client secret (or env ADMOBCTL_OAUTH_CLIENT_SECRET)")
    .option("--write", "also grant admob.monetization, needed by the write commands (create, mediation changes)")
    .option("--payments", "also grant adsense.readonly, needed by finance balance")
    .option("--cloud-platform", "also grant cloud-platform, needed by setup project/API management")
    .action(async (o: { clientId?: string; clientSecret?: string; write?: boolean; payments?: boolean; cloudPlatform?: boolean }, cmd: Command) => oauthSignIn(cmd, o));

  auth
    .command("logout")
    .description("Forget the saved OAuth login and go back to gcloud ADC")
    .action(async (_o, cmd: Command) => {
      const profileName = g(cmd).profile ?? loadConfig(dir()).defaultProfile ?? "default";
      await logout({ configDir: dir(), profile: profileName, store: defaultSecretStore(dir(), io.service?.exec), fetch: io.service?.fetch });
      io.stderr(`Logged out of profile "${profileName}".\n`);
    });

  auth
    .command("status")
    .description("Show which credentials are active")
    .action(async (_o, cmd: Command) => {
      const s = svc(cmd);
      const info: Record<string, unknown> = {
        profile: s.profile.name,
        mode: s.tokenProvider.mode,
        quotaProject: s.profile.quotaProject ?? s.tokenProvider.quotaProject() ?? null,
        account: s.configuredAccount ?? "(auto)",
      };
      try {
        const ti = await fetchTokenInfo(await s.tokenProvider.getToken(), io.service?.fetch);
        info.scopes = ti.scopes;
        if (ti.email) info.email = ti.email;
        info.tokenExpiresInSeconds = ti.expiresIn;
      } catch (err) {
        info.error = err instanceof AdmobctlError ? `${err.message}${err.fix ? ` (fix: ${err.fix})` : ""}` : String(err);
      }
      emit(cmd, keyValueView(info));
    });

  auth
    .command("doctor")
    .description("Diagnose setup problems and print the exact admobctl command that fixes each (same as setup status)")
    .action(async (_o, cmd: Command) => emitStatus(cmd));

  // ── setup ─────────────────────────────────────────────────────────
  /** setup and its subcommands share --features/--yes; commander may hand them to either, so read both. */
  const setupOpts = (cmd: Command) => cmd.optsWithGlobals<{ features?: string; project?: string; yes?: boolean }>();
  const featuresOption = () => new Option("--features <list>", "extra features: write (write commands), payments (finance balance); read is always on");
  const setup = program
    .command("setup")
    .description("Set up admobctl step by step: sign-in, Cloud project, APIs. Prints the one next command when it needs you")
    .addOption(featuresOption())
    .option("--project <id>", "Google Cloud project to use for API quota")
    .addOption(yesOption())
    .action(async (o: { features?: string; project?: string; yes?: boolean }, cmd: Command) =>
      emitSetup(cmd, await runSetup(setupCtx(cmd), { features: parseFeatures(o.features), project: o.project, yes: !!o.yes })),
    );
  setup
    .command("status")
    .description("Every setup check, with the admobctl command that fixes each gap; exits 1 on a failure")
    .action(async (_o, cmd: Command) => emitStatus(cmd));
  setup
    .command("login")
    .description("Sign in with the scopes your features need (gcloud opens the browser); keeps scopes you already have")
    .addOption(featuresOption())
    .addOption(yesOption())
    .action(async (_o, cmd: Command) => {
      const ctx = setupCtx(cmd);
      const o = setupOpts(cmd);
      await runStep(cmd, await planLogin(ctx, parseFeatures(o.features)), o.yes, (p) => applyLogin(ctx, p));
    });
  const project = setup.command("project").description("The Google Cloud project used for API quota");
  project
    .command("list")
    .description("Google Cloud projects you can use")
    .action(async (_o, cmd: Command) => emit(cmd, projectsView(await setupCtx(cmd).cloud.listProjects())));
  project
    .command("use <id>")
    .description("Use this project for API quota (stored in the profile)")
    .addOption(yesOption())
    .action(async (id: string, _o, cmd: Command) => {
      const ctx = setupCtx(cmd);
      await runStep(cmd, await planProject(ctx, id), setupOpts(cmd).yes, (p) => applyProject(ctx, p));
    });
  setup
    .command("apis")
    .description("Enable the Google APIs your features need in the chosen project")
    .option("--project <id>", "API consumer project (defaults to the quota project; does not change the profile)")
    .addOption(featuresOption())
    .addOption(yesOption())
    .action(async (_o, cmd: Command) => {
      const ctx = setupCtx(cmd);
      const o = setupOpts(cmd);
      await runStep(cmd, await planApis(ctx, parseFeatures(o.features), o.project), o.yes, (p) => applyApis(ctx, p));
    });

  // ── accounts / apps / ad-units ────────────────────────────────────
  program
    .command("accounts")
    .description("AdMob publisher accounts")
    .command("list")
    .description("List accessible publisher accounts")
    .action(async (_o, cmd: Command) => emit(cmd, accountsView(await svc(cmd).listAccounts())));

  const apps = program.command("apps").description("Apps in the account");
  apps
    .command("list")
    .description("List apps with their aliases")
    .action(async (_o, cmd: Command) => emit(cmd, appsView(await svc(cmd).apps())));
  apps
    .command("app-ads")
    .description("Check each app's app-ads.txt the way AdMob's crawler does; exits 1 on a problem")
    .option("--app <alias|id>", "only this app")
    .option("--website <url>", "developer website for apps whose store listing cannot be read (Android)")
    .action(async (o: { app?: string; website?: string }, cmd: Command) => {
      const r = await checkAppAds(svc(cmd), o);
      emit(cmd, appAdsView(r));
      if (r.problems) process.exitCode = 1;
    });
  apps
    .command("create")
    .description("Create an app (v1beta write; needs admob.monetization and Google allowlisting)")
    .requiredOption("--platform <platform>", "ios or android")
    .option("--name <name>", "name of an app that is not in a store yet")
    .option("--store-id <id>", "App Store ID or Android package name of a published app")
    .addOption(yesOption())
    .action(async (o: { platform: string; name?: string; storeId?: string; yes?: boolean }, cmd: Command) => {
      const s = svc(cmd);
      await runWrite(cmd, s, [await planCreateApp(s, o)], o.yes);
    });

  const adUnits = program.command("ad-units").description("Ad units in the account");
  adUnits
    .command("list")
    .description("List ad units")
    .option("--app <alias|id>", "only ad units of this app")
    .action(async (o: { app?: string }, cmd: Command) => emit(cmd, adUnitsView(await svc(cmd).adUnits({ app: o.app }))));
  adUnits
    .command("create")
    .description("Create an ad unit (v1beta write; needs admob.monetization and Google allowlisting)")
    .requiredOption("--app <alias|id>", "the app")
    .requiredOption("--name <name>", "display name")
    .requiredOption("--format <format>", "app-open, banner, interstitial, native, rewarded or rewarded-interstitial")
    .option("--ad-types <types>", "rich-media and/or video, comma-separated", list)
    .option("--reward <amount:item>", "reward settings for rewarded units, e.g. 10:coins")
    .addOption(yesOption())
    .action(async (o: { app: string; name: string; format: string; adTypes?: string[]; reward?: string; yes?: boolean }, cmd: Command) => {
      let reward: { amount: number; item: string } | undefined;
      if (o.reward) {
        const m = /^(\d+):(.+)$/.exec(o.reward.trim());
        if (!m) throw new AdmobctlError("USAGE", `--reward expects amount:item like 10:coins, got "${o.reward}"`);
        reward = { amount: Number(m[1]), item: m[2]!.trim() };
      }
      const s = svc(cmd);
      await runWrite(cmd, s, [await planCreateAdUnit(s, { app: o.app, name: o.name, format: o.format, adTypes: o.adTypes, reward })], o.yes);
    });
  adUnits
    .command("map <ad-unit>")
    .description("Map an ad unit to a third-party ad source adapter (v1beta write)")
    .requiredOption("--ad-source <name|id>", "the ad source (admobctl ad-sources list)")
    .requiredOption("--adapter <title|id>", "the adapter (admobctl ad-sources adapters <source>)")
    .option("--name <name>", "display name for the mapping")
    .option("--set <label=value>", "an adapter setting, repeatable (e.g. \"Placement ID=abc\")", repeat)
    .addOption(yesOption())
    .action(async (adUnit: string, o: { adSource: string; adapter: string; name?: string; set?: string[]; yes?: boolean }, cmd: Command) => {
      const s = svc(cmd);
      const plan = await planCreateMapping(s, { adUnit, adSource: o.adSource, adapter: o.adapter, name: o.name, settings: parsePairs(o.set, "--set") });
      await runWrite(cmd, s, [plan], o.yes);
    });
  adUnits
    .command("map-batch")
    .description("Create many ad unit mappings from a JSON file, 100 per request (v1beta write)")
    .requiredOption("--file <path>", "JSON array of {adUnit, adSource, adapter, name?, settings}")
    .addOption(yesOption())
    .action(async (o: { file: string; yes?: boolean }, cmd: Command) => {
      const s = svc(cmd);
      await runWrite(cmd, s, await planCreateMappings(s, parseMappingEntries(readJsonFile(o.file))), o.yes);
    });
  adUnits
    .command("mappings <ad-unit>")
    .description("Third-party ad unit mappings of an ad unit (name or ID; AdMob API v1beta)")
    .action(async (adUnit: string, _o, cmd: Command) => emit(cmd, mappingsView(await svc(cmd).adUnitMappings(adUnit))));

  // ── mediation (v1beta) ────────────────────────────────────────────
  const adSources = program.command("ad-sources").description("Mediation ad sources and their adapters (AdMob API v1beta)");
  adSources
    .command("list")
    .description("List the ad sources available for mediation")
    .action(async (_o, cmd: Command) => emit(cmd, adSourcesView(await svc(cmd).adSources())));
  adSources
    .command("adapters <ad-source>")
    .description("List an ad source's adapters and the settings an ad unit mapping needs")
    .action(async (source: string, _o, cmd: Command) => emit(cmd, adaptersView(await svc(cmd).adapters(source))));

  const groups = program.command("mediation-groups").description("Mediation groups (AdMob API v1beta; may need Google allowlisting)");
  groups
    .command("list")
    .description("List mediation groups with their targeting, lines and A/B experiment state")
    .option("--app <alias|id>", "only groups targeting this app")
    .option("--ad-source <name|id>", "only groups with a line for this ad source")
    .option("--format <format>", "e.g. banner, interstitial, rewarded")
    .option("--platform <platform>", "ios or android")
    .option("--state <state>", "enabled or disabled")
    .action(async (o: { app?: string; adSource?: string; format?: string; platform?: string; state?: string }, cmd: Command) =>
      emit(cmd, mediationGroupsView(await svc(cmd).mediationGroups(o))),
    );
  groups
    .command("show <group>")
    .description("Show one mediation group's lines (name or ID)")
    .action(async (group: string, _o, cmd: Command) => emit(cmd, mediationGroupView(await svc(cmd).mediationGroup(group))));
  groups
    .command("export [group]")
    .description("Print a group (or all groups) as the JSON that `mediation-groups create --file` takes, for backup or cloning")
    .option("--name <name>", "display name for the exported copy (one group)")
    .option("--with-admob-line", "keep the AdMob Network line (left out by default: a new group gets its own, and create may reject or duplicate it)")
    .option("--out <file>", "write to this file (readable only by you) instead of stdout")
    .action(async (group: string | undefined, o: { name?: string; withAdmobLine?: boolean; out?: string }, cmd: Command) => {
      const r = await exportMediationGroups(svc(cmd), { group, name: o.name, admobLine: o.withAdmobLine });
      // Always JSON, whatever -o says: the output is a file for `create --file`. One group is one object.
      const content = `${JSON.stringify(group ? r.groups[0] : r.groups, null, 2)}\n`;
      if (o.out) {
        writeFileSync(o.out, content, { mode: 0o600 });
        chmodSync(o.out, 0o600);
        io.stderr(`Wrote ${o.out}\n`);
      } else io.stdout(content);
      for (const n of r.notes) io.stderr(`${n}\n`);
    });
  groups
    .command("create")
    .description("Create a mediation group from a MediationGroup JSON file (v1beta write)")
    .requiredOption("--file <path>", "MediationGroup JSON; new lines keyed \"-1\", \"-2\"…")
    .addOption(yesOption())
    .action(async (o: { file: string; yes?: boolean }, cmd: Command) => {
      const s = svc(cmd);
      await runWrite(cmd, s, [await planCreateMediationGroup(s, readJsonFile(o.file))], o.yes);
    });
  groups
    .command("set-line <group> <line>")
    .description("Change a mediation line's manual CPM (USD), state or name (v1beta write)")
    .option("--cpm <usd>", "manual CPM in USD (MANUAL lines only)", positiveAmount)
    .option("--state <state>", "enabled or disabled")
    .option("--name <name>", "new display name")
    .addOption(yesOption())
    .action(async (group: string, line: string, o: { cpm?: number; state?: string; name?: string; yes?: boolean }, cmd: Command) => {
      const s = svc(cmd);
      await runWrite(cmd, s, [await planUpdateLine(s, { group, line, cpm: o.cpm, state: o.state, name: o.name })], o.yes);
    });
  groups
    .command("add-line <group>")
    .description("Add a mediation line to a group (v1beta write)")
    .requiredOption("--ad-source <name|id>", "the ad source")
    .requiredOption("--name <name>", "display name for the line")
    .option("--cpm <usd>", "manual CPM in USD; omit for a LIVE (bidding/optimized) line", positiveAmount)
    .option("--mapping <ad-unit=mapping>", "ad unit mapping resource for an ad unit, repeatable", repeat)
    .addOption(yesOption())
    .action(async (group: string, o: { adSource: string; name: string; cpm?: number; mapping?: string[]; yes?: boolean }, cmd: Command) => {
      const s = svc(cmd);
      const plan = await planAddLine(s, { group, adSource: o.adSource, name: o.name, cpm: o.cpm, mappings: parsePairs(o.mapping, "--mapping") });
      await runWrite(cmd, s, [plan], o.yes);
    });
  groups
    .command("set-ad-units <group> <ad-units...>")
    .description("Replace the ad units a mediation group targets (v1beta write)")
    .addOption(yesOption())
    .action(async (group: string, adUnits: string[], o: { yes?: boolean }, cmd: Command) => {
      const s = svc(cmd);
      await runWrite(cmd, s, [await planSetGroupAdUnits(s, { group, adUnits })], o.yes);
    });
  const experiment = groups.command("experiment").description("Mediation A/B experiments (v1beta write)");
  experiment
    .command("start <group>")
    .description("Start an A/B experiment: a share of traffic gets the treatment lines")
    .requiredOption("--name <name>", "experiment name")
    .requiredOption("--percent <n>", "share of traffic for the treatment (1-99)", positiveInt)
    .requiredOption("--lines <path>", "JSON array of the treatment's mediation lines")
    .addOption(yesOption())
    .action(async (group: string, o: { name: string; percent: number; lines: string; yes?: boolean }, cmd: Command) => {
      const s = svc(cmd);
      const lines = readJsonFile(o.lines);
      await runWrite(cmd, s, [await planStartExperiment(s, { group, name: o.name, percent: o.percent, lines: lines as unknown[] })], o.yes);
    });
  experiment
    .command("stop <group>")
    .description("Stop the running A/B experiment and keep one variant")
    .requiredOption("--keep <A|B>", "A keeps the original lines, B the treatment")
    .addOption(yesOption())
    .action(async (group: string, o: { keep: string; yes?: boolean }, cmd: Command) => {
      const s = svc(cmd);
      await runWrite(cmd, s, [await planStopExperiment(s, { group, keep: o.keep })], o.yes);
    });

  // ── report ────────────────────────────────────────────────────────
  const report = program.command("report").description("Network and mediation reports");
  for (const kind of ["network", "mediation"] as const) {
    report
      .command(kind)
      .description(`Generate a ${kind} report`)
      .requiredOption("--from <date>", "start, YYYY-MM or YYYY-MM-DD")
      .option("--to <date>", "end, YYYY-MM or YYYY-MM-DD (default: same as --from)")
      .option("--by <dims>", `dimensions, comma-separated (e.g. app,country${kind === "mediation" ? ",ad-source" : ""})`, list)
      .option("--metrics <metrics>", "metrics, comma-separated (default: all common ones)", list)
      .option("--filter <k=v,…>", "filter, repeatable (e.g. country=NO,SE or app=<alias>)", (v, p: string[] = []) => [...p, v])
      .option("--max-rows <n>", "cap the number of rows", positiveInt)
      .option("--currency <code>", "convert earnings to this ISO 4217 currency (default: the account currency)")
      .option("--sort <field[:asc|desc]>", "sort by a dimension or metric of the report (default: by time, else by earnings)")
      .addOption(new Option("--compare <period>", "add each row's change against the equal-length period just before").choices([...COMPARISONS]))
      .action(async (o: { from: string; to?: string; by?: string[]; metrics?: string[]; filter?: string[]; maxRows?: number; currency?: string; sort?: string; compare?: string }, cmd: Command) => {
        const s = svc(cmd);
        const q = {
          from: o.from,
          to: o.to ?? o.from,
          by: o.by?.length ? o.by : ["app"],
          metrics: o.metrics,
          filters: parseFilters(o.filter),
          maxRows: o.maxRows,
          currency: o.currency,
          sort: o.sort,
          compare: o.compare,
        };
        emit(cmd, reportView(kind === "network" ? await s.networkReport(q) : await s.mediationReport(q)));
      });
  }

  report
    .command("campaign")
    .description("AdMob app-promotion campaign report: impressions, clicks, installs, cost, CPI (AdMob API v1beta)")
    .requiredOption("--from <date>", "start, YYYY-MM or YYYY-MM-DD")
    .option("--to <date>", "end, YYYY-MM or YYYY-MM-DD (default: same as --from); ranges over 30 days are fetched in chunks")
    .option("--by <dims>", "dimensions, comma-separated (e.g. campaign, ad, placement, country, format, date)", list)
    .option("--metrics <metrics>", "metrics: impressions, clicks, ctr, installs, cost, cpi, interactions", list)
    .action(async (o: { from: string; to?: string; by?: string[]; metrics?: string[] }, cmd: Command) => {
      const r = await svc(cmd).campaignReport({ from: o.from, to: o.to ?? o.from, by: o.by?.length ? o.by : ["campaign"], metrics: o.metrics });
      emit(cmd, reportView(r));
    });

  // ── finance ───────────────────────────────────────────────────────
  type AsFormat = "summary" | "journal" | "csv" | "json";
  const AS_FORMATS: AsFormat[] = ["summary", "journal", "csv", "json"];
  const asOption = () =>
    new Option("--as <kind>", "summary (default), journal (paste-ready TSV rows), csv or json").choices(AS_FORMATS).default("summary");
  /** --as csv/json are shorthands for -o; --as journal prints TSV unless -o is given explicitly. */
  const emitFinance = (cmd: Command, as: AsFormat, summary: Output, journal: () => Output) => {
    const explicit = g(cmd).output;
    if (as === "journal") {
      const out = journal();
      if (explicit) io.stdout(render(out, explicit));
      else {
        io.stdout(renderTsv(out.table));
        for (const n of out.notes ?? []) io.stderr(`${n}\n`);
      }
      return;
    }
    const format = as === "csv" || as === "json" ? as : (explicit ?? defaultFormat(io.isTTY));
    io.stdout(render(summary, format));
  };

  const finance = program.command("finance").description("Monthly earnings for bookkeeping (estimates)");
  finance
    .command("month <YYYY-MM>")
    .description("Estimated earnings per app for one month, optionally as journal rows")
    .addOption(asOption())
    .action(async (month: string, o: { as: AsFormat }, cmd: Command) => {
      const s = svc(cmd);
      const m = await financeMonth(s, month);
      emitFinance(cmd, o.as, financeMonthView(m), () => journalView(journalRows(m, s.profile.finance), m.notes));
    });
  finance
    .command("forecast [YYYY-MM]")
    .description("Month-to-date earnings per app and a month-end projection from the daily average (default: this month)")
    .addOption(new Option("--as <kind>", "summary (default), csv or json").choices(["summary", "csv", "json"]).default("summary"))
    .action(async (month: string | undefined, o: { as: AsFormat }, cmd: Command) => {
      const view = financeForecastView(await financeForecast(svc(cmd), month));
      emitFinance(cmd, o.as, view, () => view);
    });
  finance
    .command("balance")
    .description("Current unpaid balance from Google payments (includes AdMob earnings; needs the adsense.readonly scope)")
    .addOption(new Option("--as <kind>", "summary (default), csv or json").choices(["summary", "csv", "json"]).default("summary"))
    .action(async (o: { as: AsFormat }, cmd: Command) => {
      const view = financeBalanceView(await financeBalance(svc(cmd)));
      emitFinance(cmd, o.as, view, () => view);
    });
  finance
    .command("export")
    .description("Export accrual vouchers in the Revenue Journal format (spec/SPEC.md), for accounting imports")
    .option("--month <YYYY-MM>", "one month")
    .option("--from <YYYY-MM>", "first month of a range")
    .option("--to <YYYY-MM>", "last month of a range")
    .option("--as <format>", `export format: ${EXPORT_FORMATS.join(", ")}`, "revenue-journal-json")
    .option("--integer-amounts", "write amounts as JSON integers instead of decimal strings (JSON only)")
    .option("--scale <digits>", "decimal places the integers carry, 0-6 (default: the currency's, e.g. 2; 6 = micros)", (v) => Number(v))
    .option("--allow-incomplete", "export a month that has not ended as a partial voucher through yesterday (its own ID)")
    .option("--out <file>", "write to this file (readable only by you) instead of stdout")
    .action(
      async (
        o: { month?: string; from?: string; to?: string; as: string; integerAmounts?: boolean; scale?: number; allowIncomplete?: boolean; out?: string },
        cmd: Command,
      ) => {
        const { content, notes } = await exportJournal(svc(cmd), o);
        if (o.out) {
          writeFileSync(o.out, content, { mode: 0o600 });
          chmodSync(o.out, 0o600);
          io.stderr(`Wrote ${o.out}\n`);
        } else io.stdout(content);
        for (const n of notes) io.stderr(`${n}\n`);
      },
    );
  finance
    .command("range")
    .description("Estimated earnings per month over a range")
    .requiredOption("--from <YYYY-MM>", "first month")
    .requiredOption("--to <YYYY-MM>", "last month")
    .addOption(asOption())
    .action(async (o: { from: string; to: string; as: AsFormat }, cmd: Command) => {
      const s = svc(cmd);
      const r = await financeRange(s, o.from, o.to);
      emitFinance(cmd, o.as, financeRangeView(r), () =>
        journalView(r.months.flatMap((m) => journalRows(m, s.profile.finance)), r.notes),
      );
    });

  // ── insights ──────────────────────────────────────────────────────
  program
    .command("insights")
    .description("Monetization insights: top/bottom earners, low fill, swings vs the previous period")
    .option("--last <Nd>", "the last N complete days (default 30d)", (v) => parseDays(v))
    .option("--from <date>", "start, YYYY-MM or YYYY-MM-DD (instead of --last)")
    .option("--to <date>", "end, YYYY-MM or YYYY-MM-DD")
    .addOption(new Option("--by <dimension>", "group by").choices([...INSIGHT_DIMENSIONS]).default("ad-unit"))
    .option("--swing <percent>", "change that counts as a swing (default 30)", positiveInt)
    .option("--currency <code>", "convert earnings to this ISO 4217 currency (default: the account currency)")
    .action(async (o: { last?: number; from?: string; to?: string; by: InsightDimension; swing?: number; currency?: string }, cmd: Command) => {
      const r = await insights(svc(cmd), {
        last: o.last,
        from: o.from,
        to: o.to,
        by: o.by,
        swingThreshold: o.swing === undefined ? undefined : o.swing / 100,
        currency: o.currency,
      });
      emit(cmd, insightsView(r));
    });

  // ── check ─────────────────────────────────────────────────────────
  program
    .command("check")
    .description("Health check for cron: exits 1 when an app's earnings, match rate or show rate dropped against the days before")
    .option("--window <Nd>", "complete days to judge, ending yesterday (default 1d)", (v) => parseDays(v, "--window"))
    .option("--baseline <Nd>", "days just before the window to compare with (default 7d)", (v) => parseDays(v, "--baseline"))
    .option("--drop <percent>", "a drop of this much or more is a breach (default 30)", positiveInt)
    .option("--min-requests <n>", "baseline requests an app needs before it is judged (default 1000)", positiveInt)
    .option("--app <alias|id>", "only this app")
    .action(async (o: { window?: number; baseline?: number; drop?: number; minRequests?: number; app?: string }, cmd: Command) => {
      const r = await check(svc(cmd), { ...o, drop: o.drop === undefined ? undefined : o.drop / 100 });
      emit(cmd, checkView(r));
      if (r.breaches) process.exitCode = 1;
    });

  // ── analyze ───────────────────────────────────────────────────────
  type RangeOpts = { last?: number; from?: string; to?: string };
  const withRange = (cmd: Command) =>
    cmd
      .option("--last <Nd>", "the last N complete days (default 30d)", (v) => parseDays(v))
      .option("--from <date>", "start, YYYY-MM or YYYY-MM-DD (instead of --last)")
      .option("--to <date>", "end, YYYY-MM or YYYY-MM-DD");
  const range = (o: RangeOpts) => ({ last: o.last, from: o.from, to: o.to });
  withRange(
    program
      .command("lint")
      .description("Check the setup: apps needing action, broken mediation groups, ad units that are unused or in no group; exits 1 on a problem")
      .option("--app <alias|id>", "only this app"),
  ).action(async (o: RangeOpts & { app?: string }, cmd: Command) => {
    const r = await lint(svc(cmd), { ...range(o), app: o.app });
    emit(cmd, lintView(r));
    if (r.problems) process.exitCode = 1;
  });

  const analyze = program
    .command("analyze")
    .description("Curated analyses: SDK/app/OS version health, consent (serving restriction) impact, mediation waterfall, country and format mix, daily trend");
  withRange(
    analyze
      .command("versions")
      .description("Match and show rate per SDK, app or OS version, flagging versions that do worse than the rest")
      .addOption(new Option("--by <kind>", "which version").choices([...VERSION_KINDS]).default("sdk"))
      .option("--app <alias|id>", "only this app"),
  ).action(async (o: RangeOpts & { by: VersionKind; app?: string }, cmd: Command) => {
    emit(cmd, versionsView(await analyzeVersions(svc(cmd), { ...range(o), by: o.by, app: o.app })));
  });
  withRange(
    analyze
      .command("consent")
      .description("Traffic and eCPM by serving restriction (consent, RDP, limited ads) vs unrestricted traffic")
      .option("--app <alias|id>", "only this app")
      .option("--currency <code>", "convert earnings to this ISO 4217 currency"),
  ).action(async (o: RangeOpts & { app?: string; currency?: string }, cmd: Command) => {
    emit(cmd, consentView(await analyzeConsent(svc(cmd), { ...range(o), app: o.app, currency: o.currency })));
  });
  withRange(
    analyze
      .command("waterfall")
      .description("Mediation lines per group by observed eCPM, with idle and low-fill lines flagged")
      .option("--app <alias|id>", "only this app")
      .option("--group <name|id>", "only this mediation group")
      .option("--currency <code>", "convert earnings to this ISO 4217 currency"),
  ).action(async (o: RangeOpts & { app?: string; group?: string; currency?: string }, cmd: Command) => {
    emit(cmd, waterfallView(await analyzeWaterfall(svc(cmd), { ...range(o), app: o.app, group: o.group, currency: o.currency })));
  });

  withRange(
    analyze
      .command("geo")
      .description("Earnings, fill and eCPM per country and format, flagging big cells that fill badly and small ones that pay well")
      .option("--app <alias|id>", "only this app")
      .option("--min-requests <n>", "requests a country and format need before they are judged (default 1000)", positiveInt)
      .option("--currency <code>", "convert earnings to this ISO 4217 currency"),
  ).action(async (o: RangeOpts & { app?: string; minRequests?: number; currency?: string }, cmd: Command) => {
    emit(cmd, geoView(await analyzeGeo(svc(cmd), { ...range(o), app: o.app, minRequests: o.minRequests, currency: o.currency })));
  });
  withRange(
    analyze
      .command("trend")
      .description("Daily earnings series: the day a level change started, weekday pattern, first day with traffic")
      .addOption(new Option("--by <split>", "one series per").choices([...TREND_SPLITS]).default("total"))
      .option("--app <alias|id>", "only this app")
      .option("--currency <code>", "convert earnings to this ISO 4217 currency"),
  ).action(async (o: RangeOpts & { by: TrendSplit; app?: string; currency?: string }, cmd: Command) => {
    emit(cmd, trendView(await analyzeTrend(svc(cmd), { ...range(o), by: o.by, app: o.app, currency: o.currency })));
  });

  // ── mcp ───────────────────────────────────────────────────────────
  program
    .command("mcp")
    .description("Run the MCP server over stdio (for Claude Code, Codex and other MCP clients)")
    .action(async (_o, cmd: Command) => {
      if (!io.runMcp) throw new AdmobctlError("USAGE", "The mcp command is not available in this build (no MCP server wired in).");
      const { profile, account } = g(cmd);
      await io.runMcp({
        service: (opts) => AdmobService.create({ profile, account: opts.account ?? account }, io.service),
      });
      // Keep running until the client closes stdin.
      await new Promise<void>((resolve) => process.stdin.on("close", resolve));
    });

  // ── audit log ─────────────────────────────────────────────────────
  program
    .command("audit-log")
    .description("Show the writes applied with --yes (from the local audit log), newest first")
    .option("--last <n>", "only the newest n entries", positiveInt)
    .option("--failed", "only writes the API rejected")
    .action((o: { last?: number; failed?: boolean }, cmd: Command) => emit(cmd, auditLogView(readAudit(dir(), o))));

  // ── config ────────────────────────────────────────────────────────
  const config = program.command("config").description("Read and write ~/.admobctl/config.json (no secrets)");
  config
    .command("get [key]")
    .description("Show the resolved profile, or one key")
    .action((key: string | undefined, _o, cmd: Command) => {
      const p = resolveProfile(loadConfig(dir()), g(cmd).profile);
      const all = p as unknown as Record<string, unknown>;
      if (!key) return emit(cmd, keyValueView(all));
      const value = key.split(".").reduce<unknown>((acc, k) => (acc as Record<string, unknown> | undefined)?.[k], all);
      emit(cmd, keyValueView({ [key]: value ?? null }));
    });
  config
    .command("set <key> <value>")
    .description("Set a key, e.g. account, quotaProject, finance.revenueAccount, aliases.<alias>")
    .action((key: string, value: string, _o, cmd: Command) => {
      const cfg = loadConfig(dir());
      setProfileValue(cfg, g(cmd).profile ?? cfg.defaultProfile ?? "default", key, value);
      saveConfig(dir(), cfg);
      io.stderr(`set ${key}\n`);
    });
  config
    .command("unset <key>")
    .description("Remove a key")
    .action((key: string, _o, cmd: Command) => {
      const cfg = loadConfig(dir());
      setProfileValue(cfg, g(cmd).profile ?? cfg.defaultProfile ?? "default", key, undefined);
      saveConfig(dir(), cfg);
      io.stderr(`unset ${key}\n`);
    });
  config
    .command("path")
    .description("Print the config file path")
    .action(() => io.stdout(`${configPath(dir())}\n`));

  return program;
}

function reportError(io: CliIO, err: unknown, json: boolean): number {
  if (err instanceof AdmobctlError) {
    if (json) io.stderr(`${JSON.stringify({ error: err.toJSON() })}\n`);
    else io.stderr(`error: ${err.message}\n${err.fix ? `  fix: ${err.fix}\n` : ""}`);
    return err.code === "USAGE" ? 2 : 1;
  }
  io.stderr(`error: ${(err as Error)?.stack ?? String(err)}\n`);
  return 1;
}

/** Parse argv and run. Returns the exit code instead of exiting, so it can be tested. */
export async function run(argv: string[], io: CliIO): Promise<number> {
  const program = buildProgram(io);
  try {
    process.exitCode = undefined;
    await program.parseAsync(argv);
    const code = Number(process.exitCode ?? 0);
    process.exitCode = undefined;
    return code;
  } catch (err) {
    if (err instanceof CommanderError) {
      // --help / --version exit with code 0; parse errors with 1 → map to usage (2).
      return err.exitCode === 0 ? 0 : 2;
    }
    const opts = program.opts<GlobalOpts>();
    if (err instanceof AdmobctlError && err.fix) {
      let configuredDefault: string | undefined;
      try { configuredDefault = loadConfig(io.service?.configDir ?? configDir()).defaultProfile; } catch { /* Preserve the original config error. */ }
      const fix = profileCommand(err.fix, opts.profile ?? configuredDefault ?? "default", configuredDefault);
      err = new AdmobctlError(err.code, err.message, { status: err.status, cause: err, fix });
    }
    return reportError(io, err, (opts.output ?? defaultFormat(io.isTTY)) === "json");
  }
}
