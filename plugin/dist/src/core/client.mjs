import { AdmobctlError } from "./errors.mjs";
import { requestJson } from "./http.mjs";
import { processLimiters } from "./ratelimit.mjs";
import { parseReport } from "./report.mjs";

//#region src/core/client.ts
const API_BASE = "https://admob.googleapis.com/v1";
/** Beta surface: ad sources, mediation groups, ad unit mappings, campaign reports, and every write method. */
const API_BASE_BETA = "https://admob.googleapis.com/v1beta";
/** AdSense Management API: only payments, for the unpaid balance (which includes AdMob earnings). */
const ADSENSE_API_BASE = "https://adsense.googleapis.com/v2";
/** "pub-123" or "accounts/pub-123" → "accounts/pub-123" */
function accountName(account) {
	return account.startsWith("accounts/") ? account : `accounts/${account}`;
}
/** Thin, typed wrapper over the AdMob REST API v1. No business logic lives here. */
var AdmobClient = class {
	opts;
	constructor(opts) {
		this.opts = opts;
	}
	async request(quota, method, path, body, version = "v1", http = {}) {
		const limiter = (this.opts.limiters ?? processLimiters)[quota];
		const headers = {
			authorization: `Bearer ${await this.opts.getToken()}`,
			accept: "application/json"
		};
		if (this.opts.quotaProject) headers["x-goog-user-project"] = this.opts.quotaProject;
		if (body !== void 0) headers["content-type"] = "application/json";
		const base = version === "v1" ? this.opts.baseUrl ?? "https://admob.googleapis.com/v1" : version === "v1beta" ? this.opts.betaBaseUrl ?? "https://admob.googleapis.com/v1beta" : this.opts.adsenseBaseUrl ?? "https://adsense.googleapis.com/v2";
		try {
			return await requestJson(`${base}/${path}`, {
				method,
				headers,
				body: body === void 0 ? void 0 : JSON.stringify(body)
			}, {
				...this.opts,
				...http,
				beforeAttempt: () => limiter.take(this.opts.sleep)
			});
		} catch (err) {
			throw version === "v1beta" ? betaError(err, path, method) : err;
		}
	}
	async paginate(quota, path, key, opts = {}) {
		const out = [];
		let pageToken;
		do {
			const qs = new URLSearchParams({
				pageSize: "1000",
				...opts.params
			});
			if (pageToken) qs.set("pageToken", pageToken);
			const page = await this.request(quota, "GET", `${path}?${qs}`, void 0, opts.version);
			out.push(...page?.[key] ?? []);
			pageToken = page?.nextPageToken || void 0;
		} while (pageToken);
		return out;
	}
	listAccounts() {
		return this.paginate("account", "accounts", "account");
	}
	listApps(account) {
		return this.paginate("inventory", `${accountName(account)}/apps`, "apps");
	}
	listAdUnits(account) {
		return this.paginate("inventory", `${accountName(account)}/adUnits`, "adUnits");
	}
	async networkReport(account, spec) {
		const raw = await this.request("reporting", "POST", `${accountName(account)}/networkReport:generate`, { reportSpec: spec });
		return parseReport(raw);
	}
	async mediationReport(account, spec) {
		const raw = await this.request("reporting", "POST", `${accountName(account)}/mediationReport:generate`, { reportSpec: spec });
		return parseReport(raw);
	}
	listAdSources(account) {
		return this.paginate("inventory", `${accountName(account)}/adSources`, "adSources", { version: "v1beta" });
	}
	listAdapters(account, adSourceId) {
		return this.paginate("inventory", `${accountName(account)}/adSources/${adSourceId}/adapters`, "adapters", { version: "v1beta" });
	}
	/** `filter` uses the API's EBNF syntax, e.g. IN(FORMAT, "BANNER") AND CONTAINS_ANY(APP_IDS, "…"). */
	listMediationGroups(account, filter) {
		return this.paginate("inventory", `${accountName(account)}/mediationGroups`, "mediationGroups", {
			version: "v1beta",
			params: filter ? { filter } : void 0
		});
	}
	/** `adUnit` is the ad unit's resource name, accounts/{pub}/adUnits/{fragment}. */
	listAdUnitMappings(adUnit) {
		return this.paginate("inventory", `${adUnit}/adUnitMappings`, "adUnitMappings", { version: "v1beta" });
	}
	/** Send a write to v1beta. `path` is relative to the version root, e.g. accounts/pub-1/adUnits. */
	async write(method, path, body, query) {
		const qs = query && Object.keys(query).length ? `?${new URLSearchParams(query)}` : "";
		try {
			return await this.request("inventory", method, `${path}${qs}`, body, "v1beta", { retries: 0 });
		} catch (err) {
			if (err instanceof AdmobctlError && (err.status === void 0 || err.status >= 500)) throw new AdmobctlError(err.code, `${err.message} The change may have been applied anyway.`, {
				status: err.status,
				cause: err,
				fix: "Check with admobctl (e.g. apps list, ad-units list, mediation-groups show) before retrying, so it is not applied twice."
			});
			if (err instanceof AdmobctlError && err.code === "AUTH_SCOPE_MISSING") throw new AdmobctlError("AUTH_SCOPE_MISSING", "Write commands need the admob.monetization scope, which your credentials do not include.", {
				status: err.status,
				cause: err,
				fix: "admobctl setup login --features write --yes"
			});
			throw err;
		}
	}
	/** All payments of the publisher's Google payments account: `unpaid` plus paid ones. Not paginated. */
	async listPayments(account) {
		try {
			return (await this.request("account", "GET", `${accountName(account)}/payments`, void 0, "adsense"))?.payments ?? [];
		} catch (err) {
			throw paymentsError(err, account.replace(/^accounts\//, ""));
		}
	}
	async campaignReport(account, spec) {
		try {
			const raw = await this.request("reporting", "POST", `${accountName(account)}/campaignReport:generate`, { reportSpec: spec }, "v1beta");
			return parseReport(raw);
		} catch (err) {
			if (err instanceof AdmobctlError && err.status === 400) throw new AdmobctlError("CAMPAIGN_REPORT_REJECTED", `The AdMob API rejected the campaign report (400: ${err.message.replace(/^AdMob API error 400: /, "")}). This usually means the account has no AdMob app-promotion campaigns, or is not enabled for campaignReport (AdMob API v1beta).`, {
				status: 400,
				cause: err,
				fix: "Check AdMob → Campaigns for app-promotion campaigns. If you run some there, ask your Google AdMob account manager to enable AdMob API (v1beta) campaign reporting for this account."
			});
			throw err;
		}
	}
};
/** ("accounts/pub-1/mediationGroups?pageSize=…", GET) → "mediationGroups.list", for messages. */
function methodName(path, httpMethod) {
	const segments = path.split("?")[0].split("/");
	const last = segments[segments.length - 1];
	if (last.includes(":")) return last.replace(":", ".");
	return `${segments.length % 2 === 1 ? last : segments[segments.length - 2]}.${httpMethod === "GET" ? "list" : httpMethod === "PATCH" ? "patch" : "create"}`;
}
/** A 403 from a v1beta method usually means the account is not allowlisted for the beta, not a missing grant. */
function betaError(err, path, httpMethod) {
	if (!(err instanceof AdmobctlError) || err.code !== "PERMISSION_DENIED") return err;
	return new AdmobctlError("BETA_ACCESS_DENIED", `Permission denied for ${methodName(path, httpMethod)} (AdMob API v1beta). Google limits several v1beta methods to allowlisted accounts.`, {
		status: err.status,
		cause: err,
		fix: "If `admobctl accounts list` works, ask your Google AdMob account manager to enable AdMob API (v1beta) access for this publisher account."
	});
}
/** AdSense payments failures, phrased for `finance balance` (an optional, extra setup). */
function paymentsError(err, publisherId) {
	if (!(err instanceof AdmobctlError)) return err;
	const opts = {
		status: err.status,
		cause: err
	};
	switch (err.code) {
		case "AUTH_SCOPE_MISSING": return new AdmobctlError("AUTH_SCOPE_MISSING", "finance balance needs the adsense.readonly scope, which your credentials do not include.", {
			...opts,
			fix: "admobctl setup login --features payments --yes"
		});
		case "PERMISSION_DENIED":
		case "NOT_FOUND": return new AdmobctlError("PAYMENTS_UNAVAILABLE", `No Google payments (AdSense) account was found or accessible for ${publisherId}, so the unpaid balance is unavailable. (Google: ${err.message})`, {
			...opts,
			fix: "Check AdMob → Payments in the web UI. If your balance shows there, run admobctl auth doctor and make sure you signed in as the AdMob account owner."
		});
		default: return err;
	}
}

//#endregion
export { ADSENSE_API_BASE, API_BASE, API_BASE_BETA, AdmobClient, accountName };