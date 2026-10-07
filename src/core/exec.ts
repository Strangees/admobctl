import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { win32 } from "node:path";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Exec = (
  cmd: string,
  args: string[],
  /**
   * `interactive` connects the child to this terminal (stdin/stderr) and sends its stdout to stderr, since admobctl's
   * stdout carries only command output. Its output is then not captured.
   * `background` only starts the program (a browser): it gets none of admobctl's stdio, and the result (code 0) comes as
   * soon as it runs, without waiting for it or for anything it leaves running.
   */
  opts?: { input?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; interactive?: boolean; background?: boolean },
) => Promise<ExecResult>;

/** Spawn without a shell. Rejects only if the binary cannot be started. */
export const exec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const env = opts.env ?? process.env;
    const { file, args: argv, windowsVerbatimArguments } = spawnTarget(cmd, args, { env });
    if (opts.background) {
      const child = spawn(file, argv, { stdio: "ignore", detached: true, shell: false, env, windowsVerbatimArguments });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve({ code: 0, stdout: "", stderr: "" });
      });
      return;
    }
    // Without input there is no stdin pipe, so a child that exits early cannot break a write to it.
    const stdin = opts.input === undefined ? "ignore" : "pipe";
    const child = spawn(file, argv, {
      stdio: opts.interactive ? ["inherit", 2, "inherit"] : [stdin, "pipe", "pipe"],
      shell: false,
      env,
      windowsVerbatimArguments,
    });
    let stdout = "";
    let stderr = "";
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs) : undefined;
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    // A child that exits before reading its input breaks the pipe (EPIPE); its exit code says what happened.
    child.stdin?.on("error", () => {});
    child.stdin?.end(opts.input);
  });

export interface SpawnTarget {
  file: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Windows environment names are case-insensitive, but a copied env is a plain object. */
const envValue = (env: NodeJS.ProcessEnv, name: string) => Object.entries(env).find(([k]) => k.toUpperCase() === name.toUpperCase())?.[1];

/** The batch file (.cmd/.bat) that Windows would run for a program name, searching PATH only. */
function findBatchFile(cmd: string, env: NodeJS.ProcessEnv, exists: (p: string) => boolean): string | undefined {
  const batch = (p: string) => (/\.(cmd|bat)$/i.test(p) ? p : undefined);
  if (/[\\/]/.test(cmd)) return batch(cmd);
  const exts = (envValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const names = win32.extname(cmd) ? [cmd] : exts.map((e) => cmd + e);
  for (const dir of (envValue(env, "PATH") ?? "").split(";")) {
    const d = dir.replace(/"/g, "").trim();
    if (!d) continue;
    for (const name of names) {
      const p = win32.join(d, name);
      if (exists(p)) return batch(p);
    }
  }
  return undefined;
}

// cmd.exe's special characters: each one gets a caret.
const CMD_META = /([()[\]%!^"`<>&|;, *?])/g;

/**
 * One argument to a batch file run by `cmd.exe /d /s /c`: quoted by the C runtime's rules (for the program the batch
 * file starts), then caret-escaped twice, since cmd.exe parses it once on its own command line and again where the batch
 * file expands %*. Variable expansion (`%`, `!`) and line breaks cannot be escaped reliably there, so they are refused.
 */
function batchArg(arg: string): string {
  if (/[%!\r\n\0]/.test(arg)) throw new Error(`Argument ${JSON.stringify(arg)} cannot be passed safely to a Windows batch file.`);
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
  return quoted.replace(CMD_META, "^$1").replace(CMD_META, "^$1");
}

/**
 * What to spawn for `cmd args`. Node cannot spawn a Windows batch file (gcloud is gcloud.cmd) without a shell, so
 * there it runs through cmd.exe, by the full path found on PATH (never the current directory), with every argument
 * escaped. Everything else is spawned as is.
 */
export function spawnTarget(
  cmd: string,
  args: string[],
  o: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; isFile?: (p: string) => boolean } = {},
): SpawnTarget {
  const env = o.env ?? process.env;
  if ((o.platform ?? process.platform) !== "win32") return { file: cmd, args };
  const batch = findBatchFile(cmd, env, o.isFile ?? isFile);
  if (!batch) return { file: cmd, args };
  if (/[%!"\r\n\0]/.test(batch)) throw new Error(`The path ${batch} cannot be passed safely to cmd.exe.`);
  const line = [`"${batch}"`, ...args.map(batchArg)].join(" ");
  return { file: envValue(env, "ComSpec") ?? "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
}
