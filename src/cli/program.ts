import { Command, CommanderError, Option } from "commander";
import { fetchTokenInfo, runDoctor } from "../core/auth/doctor.js";
import { login, logout } from "../core/auth/login.js";
import { defaultSecretStore } from "../core/auth/oauth.js";
import { configDir, configPath, loadConfig, resolveProfile, saveConfig, setProfileValue } from "../core/config.js";
import { AdmobctlError } from "../core/errors.js";
import { financeMonth, financeRange, journalRows } from "../core/finance.js";
import { INSIGHT_DIMENSIONS, insights, type InsightDimension } from "../core/insights.js";
import { log } from "../core/log.js";
import { AdmobService, type ServiceDeps, type ServiceOptions } from "../core/service.js";
import { defaultFormat, OUTPUT_FORMATS, render, renderTsv, type Output, type OutputFormat } from "../output/format.js";
import { VERSION } from "../version.js";
import {
  accountsView,
  adUnitsView,
  appsView,
  doctorView,
  financeMonthView,
  financeRangeView,
  insightsView,
  journalView,
  keyValueView,
  reportView,
} from "./views.js";

export interface CliIO {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  isTTY: boolean;
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

function parseDays(v: string): number {
  const m = /^(\d+)d$/.exec(v.trim());
  if (!m) throw new AdmobctlError("USAGE", `--last expects a number of days like 30d, got "${v}"`);
  return Number(m[1]);
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

  // ── auth ──────────────────────────────────────────────────────────
  const auth = program.command("auth").description("Authenticate and diagnose credentials");

  auth
    .command("login")
    .description("Sign in with your own OAuth client (Desktop app) instead of gcloud ADC")
    .option("--client-id <id>", "OAuth client ID (Desktop app) from Google Cloud Console")
    .option("--client-secret <secret>", "OAuth client secret (or env ADMOBCTL_OAUTH_CLIENT_SECRET)")
    .action(async (o: { clientId?: string; clientSecret?: string }, cmd: Command) => {
      const profileName = g(cmd).profile ?? loadConfig(dir()).defaultProfile ?? "default";
      const clientId = o.clientId ?? resolveProfile(loadConfig(dir()), g(cmd).profile).oauthClientId;
      if (!clientId) {
        throw new AdmobctlError("USAGE", "An OAuth client ID is required.", {
          fix: "Create a Desktop app OAuth client in Google Cloud Console (APIs & Services → Credentials), then: admobctl auth login --client-id <id> --client-secret <secret>",
        });
      }
      const r = await login({
        configDir: dir(),
        profile: profileName,
        clientId,
        clientSecret: o.clientSecret ?? process.env.ADMOBCTL_OAUTH_CLIENT_SECRET,
        store: defaultSecretStore(dir(), io.service?.exec),
        fetch: io.service?.fetch,
        print: io.stderr,
      });
      io.stderr(`Signed in. Profile "${r.profile}" now uses admobctl OAuth. Run: admobctl auth doctor\n`);
    });

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
    .description("Diagnose common setup problems and print the exact fix")
    .action(async (_o, cmd: Command) => {
      const s = svc(cmd);
      const tp = s.tokenProvider;
      const checks = await runDoctor({
        mode: tp.mode,
        checkCredentials: () => tp.checkCredentials?.(),
        getToken: () => tp.getToken(),
        tokenInfo: (t) => fetchTokenInfo(t, io.service?.fetch),
        quotaProject: s.profile.quotaProject ?? tp.quotaProject(),
        listAccounts: () => s.listAccounts(),
        account: () => s.account(),
      });
      emit(cmd, doctorView(checks));
      if (checks.some((c) => c.status === "fail")) process.exitCode = 1;
    });

  // ── accounts / apps / ad-units ────────────────────────────────────
  program
    .command("accounts")
    .description("AdMob publisher accounts")
    .command("list")
    .description("List accessible publisher accounts")
    .action(async (_o, cmd: Command) => emit(cmd, accountsView(await svc(cmd).listAccounts())));

  program
    .command("apps")
    .description("Apps in the account")
    .command("list")
    .description("List apps with their aliases")
    .action(async (_o, cmd: Command) => emit(cmd, appsView(await svc(cmd).apps())));

  program
    .command("ad-units")
    .description("Ad units in the account")
    .command("list")
    .description("List ad units")
    .option("--app <alias|id>", "only ad units of this app")
    .action(async (o: { app?: string }, cmd: Command) => emit(cmd, adUnitsView(await svc(cmd).adUnits({ app: o.app }))));

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
      .action(async (o: { from: string; to?: string; by?: string[]; metrics?: string[]; filter?: string[]; maxRows?: number; currency?: string }, cmd: Command) => {
        const s = svc(cmd);
        const q = {
          from: o.from,
          to: o.to ?? o.from,
          by: o.by?.length ? o.by : ["app"],
          metrics: o.metrics,
          filters: parseFilters(o.filter),
          maxRows: o.maxRows,
          currency: o.currency,
        };
        emit(cmd, reportView(kind === "network" ? await s.networkReport(q) : await s.mediationReport(q)));
      });
  }

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
    .option("--last <Nd>", "the last N complete days (default 30d)", parseDays)
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
    return reportError(io, err, (opts.output ?? defaultFormat(io.isTTY)) === "json");
  }
}
