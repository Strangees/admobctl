import { appsNeedingAction, type AppRef } from "../aliases.js";
import type { PublisherAccount } from "../client.js";
import { AdmobctlError, ADSENSE_SCOPE, CLOUD_PLATFORM_SCOPE, MONETIZATION_SCOPE } from "../errors.js";
import { requestJson } from "../http.js";
import { apisFor, featuresFlag, featuresFromScopes, mergeFeatures, type Feature } from "../setup/features.js";
import { googleUnavailable } from "./oauth.js";

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface Check {
  id: "credentials" | "token" | "scope" | "features" | "quota-project" | "apis" | "api" | "account" | "apps" | "beta";
  status: CheckStatus;
  summary: string;
  fix?: string;
  /** The fix as a runnable admobctl command; absent when the fix is a manual step (AdMob UI, account manager). */
  fix_command?: string;
}

export interface TokenInfo {
  scopes: string[];
  email?: string;
  expiresIn?: number;
}

export interface DoctorDeps {
  mode: "adc" | "oauth";
  /** Throws an AdmobctlError when credentials are missing or unusable; returns a description otherwise. */
  checkCredentials: () => unknown | Promise<unknown>;
  getToken: () => Promise<string>;
  tokenInfo: (token: string) => Promise<TokenInfo>;
  quotaProject: string | undefined;
  listAccounts: () => Promise<PublisherAccount[]>;
  account: () => Promise<PublisherAccount>;
  /** When given, also checks that no app is waiting on the publisher in AdMob's app review. */
  listApps?: () => Promise<AppRef[]>;
  /** v1beta reads to try; Google allowlists some of them per account. Missing access is a warning only. */
  betaProbes?: Record<string, () => Promise<unknown>>;
  /** Setup features the profile uses; checks their scopes. */
  features?: Feature[];
  /** State of each API the features need, in the quota project. */
  serviceStates?: () => Promise<Record<string, string>>;
}

const ADMOB_SCOPES = ["https://www.googleapis.com/auth/admob.readonly", "https://www.googleapis.com/auth/admob.report"];

function failed(id: Check["id"], err: unknown): Check {
  if (err instanceof AdmobctlError) return { id, status: "fail", summary: err.message, fix: err.fix };
  return { id, status: "fail", summary: (err as Error).message ?? String(err) };
}

/** POST so the token never appears in a URL. Retries network errors and 429/5xx; only 400/401 means a rejected token. */
export async function fetchTokenInfo(token: string, doFetch: typeof fetch = fetch, sleep?: (ms: number) => Promise<void>): Promise<TokenInfo> {
  const j =
    (await requestJson<{ scope?: string; email?: string; expires_in?: string } | undefined>(
      "https://oauth2.googleapis.com/tokeninfo",
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ access_token: token }).toString() },
      {
        fetch: doFetch,
        sleep,
        retries: 2,
        diagnose: (status, _body, hints) =>
          status === 400 || status === 401
            ? new AdmobctlError("AUTH_TOKEN_EXPIRED", "Google rejected the access token.", { status, fix: "admobctl setup login --yes" })
            : googleUnavailable("Google's token information service (oauth2.googleapis.com)", status, hints),
      },
    )) ?? {};
  const info: TokenInfo = { scopes: (j.scope ?? "").split(/\s+/).filter(Boolean) };
  if (j.email) info.email = j.email;
  if (j.expires_in) info.expiresIn = Number(j.expires_in);
  return info;
}

/** Run the auth checks in order. Later checks are skipped when an earlier one makes them meaningless. */
export async function runDoctor(d: DoctorDeps): Promise<Check[]> {
  const checks = await runChecks(d);
  for (const c of checks) if (c.fix?.startsWith("admobctl ")) c.fix_command = c.fix.split("  (")[0];
  return checks;
}

async function runChecks(d: DoctorDeps): Promise<Check[]> {
  const checks: Check[] = [];
  // The optional checks run last, so any early stop skips them too and the check list stays stable.
  const setupChecks: Check["id"][] = d.features ? ["features", "apis"] : [];
  const optional: Check["id"][] = [...(d.listApps ? (["apps"] as const) : []), ...(d.betaProbes ? (["beta"] as const) : [])];
  const skipRest = (ids: Check["id"][], why: string) => {
    for (const id of [...ids, ...optional]) checks.push({ id, status: "skip", summary: why });
  };

  try {
    await d.checkCredentials();
    checks.push({
      id: "credentials",
      status: "ok",
      summary: d.mode === "adc" ? "gcloud Application Default Credentials (user)" : "admobctl OAuth credentials",
    });
  } catch (err) {
    checks.push(failed("credentials", err));
    skipRest(["token", "scope", ...setupChecks, "quota-project", "api", "account"], "skipped: no usable credentials");
    return checks;
  }

  let token: string;
  try {
    token = await d.getToken();
    checks.push({ id: "token", status: "ok", summary: "Access token obtained" });
  } catch (err) {
    checks.push(failed("token", err));
    skipRest(["scope", ...setupChecks, "quota-project", "api", "account"], "skipped: no access token");
    return checks;
  }

  try {
    const info = await d.tokenInfo(token);
    const granted = ADMOB_SCOPES.filter((s) => info.scopes.includes(s));
    const grantedFeatures = featuresFromScopes(info.scopes);
    checks.push(
      granted.length
        ? {
            id: "scope",
            status: "ok",
            summary: `Scope granted: ${granted.map((s) => s.split("/").pop()).join(", ")}${
              info.scopes.includes(MONETIZATION_SCOPE) ? ", admob.monetization (write commands enabled)" : ""
            }${info.scopes.includes(ADSENSE_SCOPE) ? ", adsense.readonly (finance balance enabled)" : ""}`,
          }
        : {
            id: "scope",
            status: "fail",
            summary: `Token lacks the AdMob scope (has: ${info.scopes.join(" ") || "none"})`,
            fix: "admobctl setup login --yes",
          },
    );
    if (d.features) {
      const missing = d.features.filter((f) => !grantedFeatures.includes(f));
      const missingCloudPlatform = !info.scopes.includes(CLOUD_PLATFORM_SCOPE);
      const missingScopes = [...missing, ...(missingCloudPlatform ? ["cloud-platform"] : [])];
      checks.push(
        missingScopes.length
          ? {
              id: "features",
              status: "warn",
              summary: missing.length
                ? `Your sign-in lacks the scopes for: ${missing.join(", ")}${missingCloudPlatform ? ", cloud-platform" : ""}`
                : "Your sign-in lacks the cloud-platform scope needed for setup.",
              fix: `admobctl setup login${featuresFlag(mergeFeatures(d.features, grantedFeatures))} --yes`,
            }
          : { id: "features", status: "ok", summary: `Features: ${d.features.join(", ")}` },
      );
    }
  } catch (err) {
    checks.push(failed("scope", err));
    if (d.features) checks.push({ id: "features", status: "skip", summary: "skipped: token scopes are unavailable" });
  }

  if (d.mode === "adc") {
    checks.push(
      d.quotaProject
        ? { id: "quota-project", status: "ok", summary: `Quota project: ${d.quotaProject}` }
        : {
            id: "quota-project",
            status: "warn",
            summary: "No quota project set; ADC requests to the AdMob API usually need one.",
            fix: "admobctl setup project list",
          },
    );
  } else {
    checks.push({ id: "quota-project", status: "ok", summary: "Not needed for your own OAuth client" });
  }

  if (d.serviceStates) {
    try {
      const states = await d.serviceStates();
      const off = apisFor(d.features ?? ["read"]).filter((s) => states[s] !== "ENABLED");
      checks.push(
        off.length
          ? { id: "apis", status: "fail", summary: `Not enabled in the quota project: ${off.join(", ")}`, fix: `admobctl setup apis${featuresFlag(d.features ?? ["read"])} --yes` }
          : { id: "apis", status: "ok", summary: `APIs enabled: ${apisFor(d.features ?? ["read"]).join(", ")}` },
      );
    } catch (err) {
      checks.push(failed("apis", err));
    }
  } else if (d.features) {
    checks.push({
      id: "apis",
        status: "skip",
        summary:
        d.mode === "oauth"
          ? "API enablement in the OAuth client project was not checked here; actual feature API requests will report access issues."
          : "API enablement was not checked because no service-state lookup is available.",
    });
  }

  try {
    const accounts = await d.listAccounts();
    checks.push({ id: "api", status: "ok", summary: `AdMob API reachable; ${accounts.length} account(s) accessible` });
  } catch (err) {
    checks.push(failed("api", err));
    skipRest(["account"], "skipped: API not reachable");
    return checks;
  }

  try {
    const a = await d.account();
    checks.push({ id: "account", status: "ok", summary: `Using ${a.publisherId} (${a.currencyCode}, ${a.reportingTimeZone})` });
  } catch (err) {
    checks.push(failed("account", err));
    skipRest([], "skipped: no account");
    return checks;
  }

  if (d.listApps) {
    try {
      const apps = await d.listApps();
      const blocked = appsNeedingAction(apps);
      const inReview = apps.filter((a) => a.approval === "IN_REVIEW").length;
      const review = inReview ? `; ${inReview} in review` : "";
      checks.push(
        blocked.length
          ? {
              id: "apps",
              status: "warn",
              summary: `${blocked.length} of ${apps.length} app(s) need action in AdMob review: ${blocked.map((a) => a.alias).join(", ")}${review}`,
              fix: "Open AdMob → Apps → View all apps and follow the review steps for each app marked 'Action required'.",
            }
          : { id: "apps", status: "ok", summary: `${apps.length} app(s), none waiting on you in AdMob review${review}` },
      );
    } catch (err) {
      checks.push(failed("apps", err));
    }
  }

  if (d.betaProbes) {
    const results = await Promise.all(
      Object.entries(d.betaProbes).map(async ([name, probe]) => {
        try {
          await probe();
          return { name, err: undefined };
        } catch (err) {
          return { name, err };
        }
      }),
    );
    const denied = results.find((r) => r.err instanceof AdmobctlError && r.err.code === "BETA_ACCESS_DENIED")?.err as AdmobctlError | undefined;
    const summary = results
      .map((r) =>
        `${r.name}: ${!r.err ? "ok" : r.err instanceof AdmobctlError && r.err.code === "BETA_ACCESS_DENIED" ? "no access" : `error (${(r.err as Error).message})`}`,
      )
      .join("; ");
    checks.push(
      results.every((r) => !r.err)
        ? { id: "beta", status: "ok", summary: `AdMob API v1beta: ${summary}` }
        : { id: "beta", status: "warn", summary: `AdMob API v1beta: ${summary}`, fix: denied?.fix },
    );
  }
  return checks;
}
