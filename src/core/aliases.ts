import type { App } from "./client.js";
import { usageError } from "./errors.js";

export interface AppRef {
  alias: string;
  appId: string;
  name: string;
  platform: string;
  storeId?: string;
  approval?: string;
  /** API resource name, accounts/…/apps/… */
  resource: string;
}

const TRANSLITERATE: Record<string, string> = { æ: "ae", ø: "o", å: "a", ß: "ss", œ: "oe", đ: "d", ł: "l" };

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[æøåßœđł]/g, (c) => TRANSLITERATE[c] ?? c)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function appDisplayName(app: App): string {
  return app.manualAppInfo?.displayName || app.linkedAppInfo?.displayName || app.appId;
}

function platformSuffix(platform: string): string {
  return slugify(platform || "app");
}

/** Build the alias index. Configured overrides (alias → appId) win over generated aliases. */
export function buildAppIndex(apps: App[], overrides: Record<string, string> = {}): AppRef[] {
  const overrideByApp = new Map(Object.entries(overrides).map(([alias, appId]) => [appId, alias]));
  const taken = new Set(overrideByApp.values());
  return apps.map((app) => {
    let alias = overrideByApp.get(app.appId);
    if (!alias) {
      const base = `${slugify(appDisplayName(app)) || "app"}-${platformSuffix(app.platform)}`;
      alias = base;
      for (let n = 2; taken.has(alias); n++) alias = `${base}-${n}`;
      taken.add(alias);
    }
    const ref: AppRef = {
      alias,
      appId: app.appId,
      name: appDisplayName(app),
      platform: app.platform,
      resource: app.name,
    };
    if (app.linkedAppInfo?.appStoreId) ref.storeId = app.linkedAppInfo.appStoreId;
    if (app.appApprovalState) ref.approval = app.appApprovalState;
    return ref;
  });
}

/** Resolve user input (alias, app ID, numeric ID or display name) to an app. */
export function resolveApp(input: string, index: AppRef[]): AppRef {
  const q = input.trim();
  const exact = index.find((a) => a.alias === q || a.appId === q || a.resource === q || a.appId.endsWith(`~${q}`));
  if (exact) return exact;
  const byName = index.filter((a) => a.name.toLowerCase() === q.toLowerCase());
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    throw usageError(`App name "${input}" is ambiguous: ${byName.map((a) => a.alias).join(", ")}`);
  }
  throw usageError(`Unknown app "${input}". Known apps: ${index.map((a) => a.alias).join(", ") || "(none)"}`);
}
