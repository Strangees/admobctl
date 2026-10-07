import { STATUS_CODES } from "node:http";

export const ADMOB_SCOPE = "https://www.googleapis.com/auth/admob.readonly";
export const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
/** Needed only for the write commands (create apps, ad units, mappings; change mediation). */
export const MONETIZATION_SCOPE = "https://www.googleapis.com/auth/admob.monetization";
/** Needed only for `finance balance` (AdSense Management API payments). */
export const ADSENSE_SCOPE = "https://www.googleapis.com/auth/adsense.readonly";

export type ErrorCode =
  | "USAGE"
  | "CONFIG"
  | "AUTH_NO_CREDENTIALS"
  | "AUTH_SCOPE_MISSING"
  | "AUTH_QUOTA_PROJECT_MISSING"
  | "AUTH_TOKEN_EXPIRED"
  | "AUTH_SERVICE_ACCOUNT"
  | "API_NOT_ENABLED"
  | "PERMISSION_DENIED"
  | "BETA_ACCESS_DENIED"
  | "CAMPAIGN_REPORT_REJECTED"
  | "PAYMENTS_UNAVAILABLE"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "API_ERROR";

export class AdmobctlError extends Error {
  readonly code: ErrorCode;
  /** An exact command or action that resolves the problem. */
  readonly fix?: string;
  readonly status?: number;

  constructor(code: ErrorCode, message: string, opts: { fix?: string; status?: number; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "AdmobctlError";
    this.code = code;
    this.fix = opts.fix;
    this.status = opts.status;
  }

  toJSON() {
    return { code: this.code, message: this.message, fix: this.fix, status: this.status };
  }
}

export function usageError(message: string): AdmobctlError {
  return new AdmobctlError("USAGE", message);
}

interface GoogleErrorDetail {
  "@type"?: string;
  reason?: string;
  metadata?: Record<string, string>;
}

interface GoogleErrorBody {
  error?: { code?: number; message?: string; status?: string; details?: GoogleErrorDetail[] };
}

function errorInfo(body: GoogleErrorBody): GoogleErrorDetail | undefined {
  return body.error?.details?.find((d) => d["@type"]?.endsWith("google.rpc.ErrorInfo"));
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/**
 * Human-friendly wait: seconds under 2 minutes, minutes under 2 hours (a whole hour reads as
 * "1 hour"), otherwise hours. Rounds to the nearest unit, at least 1 second.
 */
export function formatDuration(ms: number): string {
  const secs = Math.max(1, Math.round(ms / 1000));
  if (secs < 120) return plural(secs, "second");
  const mins = Math.round(ms / 60_000);
  if (mins < 120) return mins % 60 === 0 ? plural(mins / 60, "hour") : plural(mins, "minute");
  return plural(Math.round(ms / 3_600_000), "hour");
}

/** Optional context from the HTTP layer that sharpens the diagnosis. */
export interface DiagnoseHints {
  /** Server-requested wait (parsed Retry-After) from the response being diagnosed. */
  retryAfterMs?: number;
  /** The API that answered, for the message (e.g. "AdSense Management API"). Default: AdMob API. */
  api?: string;
}

const MAX_BODY_CHARS = 200;

/**
 * A short stand-in for a response body that is not Google's JSON error: an HTML page's <title> or the start of its
 * text, else the start of the body; the HTTP status text when it is empty. A front end's 502 page would otherwise
 * put kilobytes of HTML into the message.
 */
export function summarizeBody(body: unknown, status?: number): string {
  let text = "";
  if (typeof body === "string") {
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1];
    text = title ?? body.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]*>/g, " ");
  } else if (body !== undefined && body !== null) text = JSON.stringify(body);
  text = text.replace(/\s+/g, " ").trim();
  if (!text) return (status === undefined ? undefined : STATUS_CODES[status]) ?? "empty response";
  return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}…` : text;
}

/** Turn a Google API error response into an actionable AdmobctlError. */
export function diagnoseApiError(status: number, body: unknown, hints: DiagnoseHints = {}): AdmobctlError {
  const parsed: GoogleErrorBody = typeof body === "object" && body !== null ? (body as GoogleErrorBody) : {};
  const message = parsed.error?.message ?? summarizeBody(body, status);
  const api = hints.api ?? "AdMob API";
  const info = errorInfo(parsed);
  const reason = info?.reason;
  const opts = { status };

  if (/quota project/i.test(message)) {
    return new AdmobctlError("AUTH_QUOTA_PROJECT_MISSING", "No quota project is set for your Application Default Credentials.", {
      ...opts,
      fix: "admobctl setup project list",
    });
  }
  if (reason === "SERVICE_DISABLED" || /has not been used in project|is disabled/i.test(message)) {
    const project = info?.metadata?.consumer?.replace(/^projects\//, "") ?? "<PROJECT_ID>";
    const title = info?.metadata?.serviceTitle ?? "AdMob API";
    const service = info?.metadata?.service ?? "admob.googleapis.com";
    const projectFlag = project === "<PROJECT_ID>" ? "" : ` --project ${project}`;
    return new AdmobctlError("API_NOT_ENABLED", `The ${title} is not enabled in project ${project}.`, {
      ...opts,
      fix: `admobctl setup apis${service === "adsense.googleapis.com" ? " --features payments" : ""}${projectFlag} --yes`,
    });
  }
  if (reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT" || /insufficient authentication scopes/i.test(message)) {
    return new AdmobctlError("AUTH_SCOPE_MISSING", "Your credentials do not include the AdMob scope.", {
      ...opts,
      fix: "admobctl setup login --yes",
    });
  }
  if (status === 401) {
    return new AdmobctlError("AUTH_TOKEN_EXPIRED", "Your credentials are expired or invalid.", {
      ...opts,
      fix: "admobctl setup login --yes",
    });
  }
  if (status === 403) {
    return new AdmobctlError("PERMISSION_DENIED", `Permission denied: ${message}`, {
      ...opts,
      fix: "Check that the signed-in Google user has access to this AdMob account (admobctl accounts list).",
    });
  }
  if (status === 404) {
    return new AdmobctlError("NOT_FOUND", `Not found: ${message}`, {
      ...opts,
      fix: "admobctl accounts list, apps list, ad-units list and mediation-groups list show the IDs you can use; check the one in the command.",
    });
  }
  if (status === 429) {
    return new AdmobctlError("RATE_LIMITED", `Rate limited by the ${api}: ${message}`, {
      ...opts,
      fix:
        hints.retryAfterMs === undefined
          ? "Wait a minute and retry, or narrow the report."
          : `The API asked to wait: retry in about ${formatDuration(hints.retryAfterMs)}, or narrow the report.`,
    });
  }
  return new AdmobctlError("API_ERROR", `${api} error ${status}: ${message}`, {
    ...opts,
    // -v logs the response body, where Google puts the details (e.g. which field of the request was invalid).
    fix:
      status >= 500
        ? "Retry in a few minutes; if it keeps failing, re-run the command with -v to see the API's full response."
        : "Re-run the command with -v to see the API's full error response.",
  });
}
