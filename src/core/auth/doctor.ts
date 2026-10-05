import { appsNeedingAction, type AppRef } from "../aliases.js";
import type { PublisherAccount } from "../client.js";
import { AdmobctlError, ADSENSE_SCOPE, LOGIN_COMMAND, MONETIZATION_SCOPE } from "../errors.js";

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface Check {
  id: "credentials" | "token" | "scope" | "quota-project" | "api" | "account" | "apps" | "beta";
  status: CheckStatus;
  summary: string;
  fix?: string;
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
}

const ADMOB_SCOPES = ["https://www.googleapis.com/auth/admob.readonly", "https://www.googleapis.com/auth/admob.report"];

function failed(id: Check["id"], err: unknown): Check {
  if (err instanceof AdmobctlError) return { id, status: "fail", summary: err.message, fix: err.fix };
  return { id, status: "fail", summary: (err as Error).message ?? String(err) };
}

/** POST so the token never appears in a URL. */
export async function fetchTokenInfo(token: string, doFetch: typeof fetch = fetch): Promise<TokenInfo> {
  const res = await doFetch("https://oauth2.googleapis.com/tokeninfo", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ access_token: token }).toString(),
  });
  if (!res.ok) throw new AdmobctlError("AUTH_TOKEN_EXPIRED", "Google rejected the access token.", { fix: LOGIN_COMMAND });
  const j = (await res.json()) as { scope?: string; email?: string; expires_in?: string };
  const info: TokenInfo = { scopes: (j.scope ?? "").split(/\s+/).filter(Boolean) };
  if (j.email) info.email = j.email;
  if (j.expires_in) info.expiresIn = Number(j.expires_in);
  return info;
}

/** Run the auth checks in order. Later checks are skipped when an earlier one makes them meaningless. */
export async function runDoctor(d: DoctorDeps): Promise<Check[]> {
  const checks: Check[] = [];
  // The optional checks run last, so any early stop skips them too and the check list stays stable.
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
    skipRest(["token", "scope", "quota-project", "api", "account"], "skipped: no usable credentials");
    return checks;
  }

  let token: string;
  try {
    token = await d.getToken();
    checks.push({ id: "token", status: "ok", summary: "Access token obtained" });
  } catch (err) {
    checks.push(failed("token", err));
    skipRest(["scope", "quota-project", "api", "account"], "skipped: no access token");
    return checks;
  }

  try {
    const info = await d.tokenInfo(token);
    const granted = ADMOB_SCOPES.filter((s) => info.scopes.includes(s));
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
            fix: d.mode === "adc" ? LOGIN_COMMAND : "admobctl auth login",
          },
    );
  } catch (err) {
    checks.push(failed("scope", err));
  }

  if (d.mode === "adc") {
    checks.push(
      d.quotaProject
        ? { id: "quota-project", status: "ok", summary: `Quota project: ${d.quotaProject}` }
        : {
            id: "quota-project",
            status: "warn",
            summary: "No quota project set; ADC requests to the AdMob API usually need one.",
            fix: "gcloud auth application-default set-quota-project <PROJECT_ID>  (or: admobctl config set quotaProject <PROJECT_ID>)",
          },
    );
  } else {
    checks.push({ id: "quota-project", status: "ok", summary: "Not needed for your own OAuth client" });
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
