import { AdmobctlError } from "../errors.mjs";
import { exec } from "../exec.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

//#region src/core/auth/adc.ts
function adcPath(env = process.env, platform = process.platform, home = homedir()) {
	if (env.GOOGLE_APPLICATION_CREDENTIALS) return env.GOOGLE_APPLICATION_CREDENTIALS;
	const file = "application_default_credentials.json";
	if (env.CLOUDSDK_CONFIG) return join(env.CLOUDSDK_CONFIG, file);
	if (platform === "win32") return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "gcloud", file);
	return join(home, ".config", "gcloud", file);
}
/** Read only the non-secret fields of the ADC file. */
function readAdcInfo(path = adcPath(), read = (p) => readFileSync(p, "utf8")) {
	let raw;
	try {
		raw = read(path);
	} catch {
		return;
	}
	try {
		const j = JSON.parse(raw);
		const info = { path };
		if (j.type) info.type = j.type;
		if (j.quota_project_id) info.quotaProjectId = j.quota_project_id;
		return info;
	} catch {
		return { path };
	}
}
const TOKEN_TTL_MS = 27e5;
/**
* Access tokens from gcloud Application Default Credentials. We delegate token
* refresh to gcloud so we never read or store the refresh token ourselves.
*/
var AdcTokenProvider = class {
	mode = "adc";
	cached;
	info;
	env;
	exec;
	now;
	constructor(deps = {}) {
		this.env = deps.env ?? process.env;
		this.info = deps.info ?? (() => readAdcInfo(adcPath(this.env)));
		this.exec = deps.exec ?? exec;
		this.now = deps.now ?? Date.now;
	}
	resetCache() {
		this.cached = void 0;
	}
	checkCredentials() {
		const info = this.info();
		if (!info) throw new AdmobctlError("AUTH_NO_CREDENTIALS", "No gcloud Application Default Credentials found.", { fix: "admobctl setup login --yes" });
		if (info.type && info.type !== "authorized_user") {
			const fix = this.env.GOOGLE_APPLICATION_CREDENTIALS ? "Unset GOOGLE_APPLICATION_CREDENTIALS in the terminal that runs admobctl, then run admobctl setup login --yes." : "admobctl setup login --yes";
			throw new AdmobctlError("AUTH_SERVICE_ACCOUNT", `Your Application Default Credentials are a ${info.type}; the AdMob API only accepts user credentials (service accounts are not supported).`, { fix });
		}
		return info;
	}
	async getToken() {
		if (this.cached && this.now() - this.cached.at < TOKEN_TTL_MS) return this.cached.token;
		const info = this.checkCredentials();
		let res;
		try {
			const env = {
				...this.env,
				GOOGLE_APPLICATION_CREDENTIALS: info.path
			};
			res = await this.exec("gcloud", [
				"auth",
				"application-default",
				"print-access-token"
			], {
				timeoutMs: 3e4,
				env
			});
		} catch (err) {
			throw new AdmobctlError("AUTH_NO_CREDENTIALS", "Could not run gcloud (is the Google Cloud CLI installed and on PATH?).", {
				cause: err,
				fix: "admobctl setup login --yes"
			});
		}
		const token = res.stdout.trim();
		if (res.code !== 0 || !token) {
			const detail = res.stderr.trim().split("\n").pop() ?? "";
			if (/reauth|invalid_grant|refresh|expired/i.test(res.stderr)) throw new AdmobctlError("AUTH_TOKEN_EXPIRED", `gcloud could not refresh your credentials: ${detail}`, { fix: "admobctl setup login --yes" });
			throw new AdmobctlError("AUTH_NO_CREDENTIALS", `gcloud failed to print an access token: ${detail}`, { fix: "admobctl setup login --yes" });
		}
		this.cached = {
			token,
			at: this.now()
		};
		return token;
	}
	quotaProject() {
		return this.info()?.quotaProjectId;
	}
};

//#endregion
export { AdcTokenProvider, adcPath, readAdcInfo };