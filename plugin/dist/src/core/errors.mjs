//#region src/core/errors.ts
const ADMOB_SCOPE = "https://www.googleapis.com/auth/admob.readonly";
const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
/** Needed only for the write commands (create apps, ad units, mappings; change mediation). */
const MONETIZATION_SCOPE = "https://www.googleapis.com/auth/admob.monetization";
/** Needed only for `finance balance` (AdSense Management API payments). */
const ADSENSE_SCOPE = "https://www.googleapis.com/auth/adsense.readonly";
var AdmobctlError = class extends Error {
	code;
	/** An exact command or action that resolves the problem. */
	fix;
	status;
	constructor(code, message, opts = {}) {
		super(message, opts.cause === void 0 ? void 0 : { cause: opts.cause });
		this.name = "AdmobctlError";
		this.code = code;
		this.fix = opts.fix;
		this.status = opts.status;
	}
	toJSON() {
		return {
			code: this.code,
			message: this.message,
			fix: this.fix,
			status: this.status
		};
	}
};
function usageError(message) {
	return new AdmobctlError("USAGE", message);
}
function errorInfo(body) {
	return body.error?.details?.find((d) => d["@type"]?.endsWith("google.rpc.ErrorInfo"));
}
function plural(n, unit) {
	return `${n} ${unit}${n === 1 ? "" : "s"}`;
}
/**
* Human-friendly wait: seconds under 2 minutes, minutes under 2 hours (a whole hour reads as
* "1 hour"), otherwise hours. Rounds to the nearest unit, at least 1 second.
*/
function formatDuration(ms) {
	const secs = Math.max(1, Math.round(ms / 1e3));
	if (secs < 120) return plural(secs, "second");
	const mins = Math.round(ms / 6e4);
	if (mins < 120) return mins % 60 === 0 ? plural(mins / 60, "hour") : plural(mins, "minute");
	return plural(Math.round(ms / 36e5), "hour");
}
/** Turn a Google API error response into an actionable AdmobctlError. */
function diagnoseApiError(status, body, hints = {}) {
	const parsed = typeof body === "object" && body !== null ? body : {};
	const message = parsed.error?.message ?? (typeof body === "string" ? body : JSON.stringify(body));
	const info = errorInfo(parsed);
	const reason = info?.reason;
	const opts = { status };
	if (/quota project/i.test(message)) return new AdmobctlError("AUTH_QUOTA_PROJECT_MISSING", "No quota project is set for your Application Default Credentials.", {
		...opts,
		fix: "admobctl setup project list"
	});
	if (reason === "SERVICE_DISABLED" || /has not been used in project|is disabled/i.test(message)) {
		const project = info?.metadata?.consumer?.replace(/^projects\//, "") ?? "<PROJECT_ID>";
		const title = info?.metadata?.serviceTitle ?? "AdMob API";
		const service = info?.metadata?.service ?? "admob.googleapis.com";
		const projectFlag = project === "<PROJECT_ID>" ? "" : ` --project ${project}`;
		return new AdmobctlError("API_NOT_ENABLED", `The ${title} is not enabled in project ${project}.`, {
			...opts,
			fix: `admobctl setup apis${service === "adsense.googleapis.com" ? " --features payments" : ""}${projectFlag} --yes`
		});
	}
	if (reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT" || /insufficient authentication scopes/i.test(message)) return new AdmobctlError("AUTH_SCOPE_MISSING", "Your credentials do not include the AdMob scope.", {
		...opts,
		fix: "admobctl setup login --yes"
	});
	if (status === 401) return new AdmobctlError("AUTH_TOKEN_EXPIRED", "Your credentials are expired or invalid.", {
		...opts,
		fix: "admobctl setup login --yes"
	});
	if (status === 403) return new AdmobctlError("PERMISSION_DENIED", `Permission denied: ${message}`, {
		...opts,
		fix: "Check that the signed-in Google user has access to this AdMob account (admobctl accounts list)."
	});
	if (status === 404) return new AdmobctlError("NOT_FOUND", `Not found: ${message}`, opts);
	if (status === 429) return new AdmobctlError("RATE_LIMITED", `Rate limited by the AdMob API: ${message}`, {
		...opts,
		fix: hints.retryAfterMs === void 0 ? "Wait a minute and retry, or narrow the report." : `The API asked to wait: retry in about ${formatDuration(hints.retryAfterMs)}, or narrow the report.`
	});
	return new AdmobctlError("API_ERROR", `AdMob API error ${status}: ${message}`, opts);
}

//#endregion
export { ADMOB_SCOPE, ADSENSE_SCOPE, AdmobctlError, CLOUD_PLATFORM_SCOPE, MONETIZATION_SCOPE, diagnoseApiError, formatDuration, usageError };