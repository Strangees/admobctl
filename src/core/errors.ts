export const ADMOB_SCOPE = "https://www.googleapis.com/auth/admob.readonly";
export const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
export const LOGIN_COMMAND = `gcloud auth application-default login --scopes=${ADMOB_SCOPE},${CLOUD_PLATFORM_SCOPE}`;

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

/** Turn a Google API error response into an actionable AdmobctlError. */
export function diagnoseApiError(status: number, body: unknown): AdmobctlError {
  const parsed: GoogleErrorBody = typeof body === "object" && body !== null ? (body as GoogleErrorBody) : {};
  const message = parsed.error?.message ?? (typeof body === "string" ? body : JSON.stringify(body));
  const info = errorInfo(parsed);
  const reason = info?.reason;
  const opts = { status };

  if (/quota project/i.test(message)) {
    return new AdmobctlError("AUTH_QUOTA_PROJECT_MISSING", "No quota project is set for your Application Default Credentials.", {
      ...opts,
      fix: "gcloud auth application-default set-quota-project <PROJECT_ID>  (a project where the AdMob API is enabled)",
    });
  }
  if (reason === "SERVICE_DISABLED" || /has not been used in project|is disabled/i.test(message)) {
    const project = info?.metadata?.consumer?.replace(/^projects\//, "") ?? "<PROJECT_ID>";
    return new AdmobctlError("API_NOT_ENABLED", `The AdMob API is not enabled in project ${project}.`, {
      ...opts,
      fix: `gcloud services enable admob.googleapis.com --project ${project}`,
    });
  }
  if (reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT" || /insufficient authentication scopes/i.test(message)) {
    return new AdmobctlError("AUTH_SCOPE_MISSING", "Your credentials do not include the AdMob scope.", {
      ...opts,
      fix: `${LOGIN_COMMAND}  (or: admobctl auth login --client-id <id>)`,
    });
  }
  if (status === 401) {
    return new AdmobctlError("AUTH_TOKEN_EXPIRED", "Your credentials are expired or invalid.", {
      ...opts,
      fix: `${LOGIN_COMMAND}  (or: admobctl auth login)`,
    });
  }
  if (status === 403) {
    return new AdmobctlError("PERMISSION_DENIED", `Permission denied: ${message}`, {
      ...opts,
      fix: "Check that the signed-in Google user has access to this AdMob account (admobctl accounts list).",
    });
  }
  if (status === 404) return new AdmobctlError("NOT_FOUND", `Not found: ${message}`, opts);
  if (status === 429) {
    return new AdmobctlError("RATE_LIMITED", `Rate limited by the AdMob API: ${message}`, {
      ...opts,
      fix: "Wait a minute and retry, or narrow the report.",
    });
  }
  return new AdmobctlError("API_ERROR", `AdMob API error ${status}: ${message}`, opts);
}
