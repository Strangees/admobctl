import { AdmobctlError } from "../errors.mjs";
import { defaultSleep, requestJson } from "../http.mjs";

//#region src/core/setup/cloud.ts
const CRM = "https://cloudresourcemanager.googleapis.com/v3";
const SU = "https://serviceusage.googleapis.com/v1";
const POLL_MS = 2e3;
const OPERATION_TIMEOUT_MS = 12e4;
/**
* Google Cloud setup calls (Resource Manager, Service Usage) made with the user's own token.
* No quota header: both APIs accept user ADC tokens before a quota project exists (checked live 2026-10-05).
*/
var CloudClient = class {
	o;
	constructor(o) {
		this.o = o;
	}
	async call(method, url, body) {
		const headers = {
			authorization: `Bearer ${await this.o.getToken()}`,
			accept: "application/json"
		};
		if (body !== void 0) headers["content-type"] = "application/json";
		return requestJson(url, {
			method,
			headers,
			body: body === void 0 ? void 0 : JSON.stringify(body)
		}, {
			fetch: this.o.fetch,
			sleep: this.o.sleep,
			retries: method === "GET" ? 2 : 0
		});
	}
	async listProjects() {
		const out = [];
		let pageToken;
		do {
			const qs = new URLSearchParams({
				pageSize: "100",
				...pageToken ? { pageToken } : {}
			});
			const page = await this.call("GET", `${CRM}/projects:search?${qs}`);
			for (const p of page?.projects ?? []) if (!p.state || p.state === "ACTIVE") out.push({
				projectId: p.projectId,
				name: p.displayName ?? p.projectId
			});
			pageToken = page?.nextPageToken || void 0;
		} while (pageToken);
		return out;
	}
	async getProject(id) {
		try {
			const p = await this.call("GET", `${CRM}/projects/${encodeURIComponent(id)}`);
			return {
				projectId: p.projectId,
				name: p.displayName ?? p.projectId
			};
		} catch (err) {
			if (err instanceof AdmobctlError && (err.code === "PERMISSION_DENIED" || err.code === "NOT_FOUND")) throw new AdmobctlError("NOT_FOUND", `Google Cloud project "${id}" was not found, or your account cannot access it.`, {
				status: err.status,
				cause: err,
				fix: "admobctl setup project list"
			});
			throw err;
		}
	}
	async serviceStates(project, services) {
		const entries = await Promise.all(services.map(async (s) => {
			return [s, (await this.call("GET", `${SU}/projects/${encodeURIComponent(project)}/services/${s}`))?.state === "ENABLED" ? "ENABLED" : "DISABLED"];
		}));
		return Object.fromEntries(entries);
	}
	/** Enable services and wait for the long-running operation to finish. */
	async enableServices(project, services) {
		let op = await this.call("POST", `${SU}/projects/${encodeURIComponent(project)}/services:batchEnable`, { serviceIds: services });
		const sleep = this.o.sleep ?? defaultSleep;
		const now = this.o.now ?? Date.now;
		const start = now();
		while (!op.done) {
			if (now() - start >= OPERATION_TIMEOUT_MS) throw new AdmobctlError("API_ERROR", `Enabling ${services.join(", ")} in ${project} is still running after ${OPERATION_TIMEOUT_MS / 1e3} seconds.`, { fix: "admobctl setup status" });
			await sleep(POLL_MS);
			op = await this.call("GET", `${SU}/${op.name}`);
		}
		if (op.error) throw new AdmobctlError("API_ERROR", `Google could not enable ${services.join(", ")} in ${project}: ${op.error.message ?? "unknown error"}`, { fix: "admobctl setup status" });
	}
};

//#endregion
export { CloudClient };