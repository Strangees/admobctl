import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { parseFeatures, type Feature } from "./setup/features.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { AdmobctlError, usageError } from "./errors.js";
import { ensurePrivateDir } from "./fs.js";

export type AuthMode = "auto" | "adc" | "oauth";

export interface FinanceConfig {
  /** Debit account for the receivable (default 1509). */
  receivableAccount?: string;
  /** Credit account for ad revenue (default 3120). */
  revenueAccount?: string;
  receivableAccountName?: string;
  revenueAccountName?: string;
  /** Free text for the MVA-behandling column (left empty unless configured). */
  vatTreatment?: string;
  counterparty?: string;
  /** "." or "," for journal amounts. */
  decimalSeparator?: "." | ",";
}

/** check.baseline: days just before the window ("7" or "7d") or weeks of the same weekdays ("4w"). */
export const CHECK_BASELINE = /^([1-9]\d*)([dw]?)$/;

/** Defaults for `admobctl check`, stored as the strings `config set` writes. */
export interface CheckConfig {
  /** Complete days to judge (default 1). */
  window?: string;
  /** Days before the window ("7", "7d") or weeks of the same weekdays ("4w"). Default 4w, or 7d for windows over 7 days. */
  baseline?: string;
  /** Percent drop that counts as a breach (default 30). */
  drop?: string;
  /** Baseline requests an app needs before it is judged (default 1000). */
  minRequests?: string;
}

/** Everything in here is non-secret. Refresh tokens live in the OS keychain. */
export interface ProfileConfig {
  account?: string;
  quotaProject?: string;
  /** Setup features this profile uses (always includes "read"); set by `admobctl setup`. */
  features?: Feature[];
  authMode?: AuthMode;
  oauthClientId?: string;
  finance?: FinanceConfig;
  check?: CheckConfig;
  /** alias → app ID (ca-app-pub-…~…) */
  aliases?: Record<string, string>;
  /** Developer website for the app-ads.txt check, used where the store listing cannot be read (Android). */
  website?: string;
  /** Per-app developer website (alias or app ID → URL); wins over `website`. */
  websites?: Record<string, string>;
}

export interface ConfigFile {
  defaultProfile?: string;
  profiles: Record<string, ProfileConfig>;
}

export interface ResolvedProfile extends ProfileConfig {
  name: string;
  authMode: AuthMode;
  finance: Required<FinanceConfig>;
  /** Only the finance settings the user set, without defaults (Revenue Journal exports use nothing else). */
  financeConfigured: FinanceConfig;
  aliases: Record<string, string>;
}

export const DEFAULT_FINANCE: Required<FinanceConfig> = {
  receivableAccount: "1509",
  revenueAccount: "3120",
  receivableAccountName: "Fordring AdMob",
  revenueAccountName: "Annonseinntekter AdMob",
  vatTreatment: "",
  counterparty: "Google Ireland Limited",
  decimalSeparator: ".",
};

export function configDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.ADMOBCTL_HOME || join(home, ".admobctl");
}

export function configPath(dir: string): string {
  return join(dir, "config.json");
}

export function loadConfig(dir: string): ConfigFile {
  const file = configPath(dir);
  if (!existsSync(file)) return { profiles: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ConfigFile>;
    return { ...parsed, profiles: parsed.profiles ?? {} };
  } catch (err) {
    throw new AdmobctlError("CONFIG", `Could not parse ${file}: ${(err as Error).message}`, {
      fix: `Fix or delete ${file}`,
    });
  }
}

export function saveConfig(dir: string, config: ConfigFile): void {
  ensurePrivateDir(dir);
  const file = configPath(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

export function resolveProfile(config: ConfigFile, name?: string): ResolvedProfile {
  const profileName = name ?? config.defaultProfile ?? "default";
  const p = config.profiles[profileName];
  if (!p && name !== undefined && name !== "default") {
    const known = Object.keys(config.profiles);
    throw usageError(`Unknown profile "${name}". Known profiles: ${known.length ? known.join(", ") : "(none)"}`);
  }
  return {
    ...p,
    name: profileName,
    authMode: p?.authMode ?? "auto",
    finance: { ...DEFAULT_FINANCE, ...p?.finance },
    financeConfigured: { ...p?.finance },
    aliases: { ...p?.aliases },
  };
}

const SCALAR_KEYS = new Set(["account", "quotaProject", "authMode", "oauthClientId", "website"]);
const CHECK_KEYS = ["check.window", "check.baseline", "check.drop", "check.minRequests"];
const MAP_KEYS = new Set([...Object.keys(DEFAULT_FINANCE).map((k) => `finance.${k}`), ...CHECK_KEYS]);
const AUTH_MODES: AuthMode[] = ["auto", "adc", "oauth"];

export const SETTABLE_KEYS = [...SCALAR_KEYS, "features", ...MAP_KEYS, "aliases.<alias>", "websites.<alias>"];

/** Set (or with value undefined, unset) a dotted key on a profile. */
export function setProfileValue(config: ConfigFile, profile: string, key: string, value: string | undefined): void {
  const p = (config.profiles[profile] ??= {});
  if (key === "features") {
    if (value === undefined) delete p.features;
    else p.features = parseFeatures(value);
    return;
  }
  if (SCALAR_KEYS.has(key)) {
    if (key === "authMode" && value !== undefined && !AUTH_MODES.includes(value as AuthMode)) {
      throw usageError(`authMode must be one of ${AUTH_MODES.join(", ")}`);
    }
    if (value === undefined) delete (p as Record<string, unknown>)[key];
    else (p as Record<string, unknown>)[key] = value;
    return;
  }
  if (key === "finance.decimalSeparator" && value !== undefined && value !== "." && value !== ",") {
    throw usageError('finance.decimalSeparator must be "." or ","');
  }
  if (key === "check.baseline" && value !== undefined && !CHECK_BASELINE.test(value)) {
    throw usageError(`check.baseline must be days like 7d or weeks like 4w, got "${value}"`);
  }
  if (CHECK_KEYS.includes(key) && key !== "check.baseline" && value !== undefined && !/^[1-9]\d*$/.test(value)) {
    throw usageError(`${key} must be a positive whole number, got "${value}"`);
  }
  const [head, sub, ...rest] = key.split(".");
  if (rest.length === 0 && sub && (MAP_KEYS.has(key) || head === "aliases" || head === "websites")) {
    const target = ((p as Record<string, unknown>)[head!] ??= {}) as Record<string, string>;
    if (value === undefined) delete target[sub];
    else target[sub] = value;
    return;
  }
  throw usageError(`Unknown config key "${key}". Settable keys: ${SETTABLE_KEYS.join(", ")}`);
}
