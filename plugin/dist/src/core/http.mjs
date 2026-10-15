import { AdmobctlError, diagnoseApiError } from "./errors.mjs";
import { log } from "./log.mjs";

//#region src/core/http.ts
const DEFAULT_TIMEOUT_MS = 3e4;
const DEFAULT_MAX_RETRY_AFTER_MS = 6e4;
/** Combine the caller's signal (if any) with the per-attempt timeout signal. */
function combineSignals(timeout, caller) {
	if (!caller) return timeout;
	if (typeof AbortSignal.any === "function") return AbortSignal.any([caller, timeout]);
	const ctl = new AbortController();
	const forward = (s) => {
		if (s.aborted) ctl.abort(s.reason);
		else s.addEventListener("abort", () => ctl.abort(s.reason), { once: true });
	};
	forward(caller);
	forward(timeout);
	return ctl.signal;
}
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
function isRetryableStatus(status) {
	return status === 429 || status >= 500;
}
function retryAfterMs(res) {
	const h = res.headers.get("retry-after");
	if (!h) return void 0;
	const secs = Number(h);
	if (Number.isFinite(secs)) return secs * 1e3;
	const at = Date.parse(h);
	return Number.isFinite(at) ? Math.max(0, at - Date.now()) : void 0;
}
async function readBody(res) {
	const text = await res.text();
	if (!text) return void 0;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}
/**
* One attempt: fetch and read the body, all under the caller's (already combined) signal, so the
* per-attempt timeout also covers a server that sends headers and then stalls mid-body.
* Network errors, timeouts and caller aborts propagate as throws.
*/
async function attemptOnce(doFetch, url, init, canRetry, backoff, maxRetryAfterMs) {
	const res = await doFetch(url, init);
	if (res.ok) return {
		kind: "ok",
		status: res.status,
		body: await readBody(res)
	};
	if (!isRetryableStatus(res.status)) return {
		kind: "fail",
		status: res.status,
		body: await readBody(res)
	};
	const retryAfter = retryAfterMs(res);
	if (!canRetry) return {
		kind: "fail",
		status: res.status,
		body: await readBody(res),
		retryAfterMs: retryAfter
	};
	if (retryAfter !== void 0 && retryAfter > maxRetryAfterMs) {
		log.debug(`HTTP ${res.status}; Retry-After ${retryAfter}ms exceeds cap ${maxRetryAfterMs}ms; not retrying`);
		return {
			kind: "fail",
			status: res.status,
			body: await readBody(res),
			retryAfterMs: retryAfter
		};
	}
	await res.body?.cancel().catch(() => {});
	return {
		kind: "retry",
		status: res.status,
		wait: retryAfter ?? backoff
	};
}
/** fetch + JSON with exponential backoff on 429/5xx and transient network errors. */
async function requestJson(url, init, opts = {}) {
	const doFetch = opts.fetch ?? fetch;
	const sleep = opts.sleep ?? defaultSleep;
	const retries = opts.retries ?? 4;
	const base = opts.baseDelayMs ?? 500;
	const timeoutMs = opts.timeoutMs ?? 3e4;
	const maxRetryAfterMs = opts.maxRetryAfterMs ?? 6e4;
	for (let attempt = 0;; attempt++) {
		await opts.beforeAttempt?.();
		const backoff = base * 2 ** attempt + Math.floor(Math.random() * base * .25);
		const timer = new AbortController();
		const timeoutId = setTimeout(() => timer.abort(/* @__PURE__ */ new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
		let outcome;
		const started = Date.now();
		try {
			const signal = combineSignals(timer.signal, init.signal);
			outcome = await attemptOnce(doFetch, url, {
				...init,
				signal
			}, attempt < retries, backoff, maxRetryAfterMs);
		} catch (err) {
			if (init.signal?.aborted) throw err;
			const timedOut = timer.signal.aborted;
			const host = new URL(url).host;
			if (attempt >= retries) {
				if (timedOut) throw new AdmobctlError("API_ERROR", `Request to ${host} timed out after ${timeoutMs}ms (${attempt + 1} attempts).`, {
					cause: err,
					fix: "Check your connection and retry."
				});
				throw new AdmobctlError("API_ERROR", `Network error calling ${host}: ${err.message}`, {
					cause: err,
					fix: "Check your internet connection and retry."
				});
			}
			log.debug(`${timedOut ? `timeout after ${timeoutMs}ms` : `network error (${err.message})`}; retrying in ${backoff}ms`);
			await sleep(backoff);
			continue;
		} finally {
			clearTimeout(timeoutId);
		}
		log.debug(`${init.method ?? "GET"} ${url} → ${outcome.status} (${Date.now() - started}ms)`);
		if (outcome.kind === "ok") return outcome.body;
		if (outcome.kind === "fail") {
			log.debug(`response: ${(typeof outcome.body === "string" ? outcome.body : JSON.stringify(outcome.body) ?? "").slice(0, 2e3)}`);
			throw diagnoseApiError(outcome.status, outcome.body, { retryAfterMs: outcome.retryAfterMs });
		}
		log.debug(`HTTP ${outcome.status}; retrying in ${outcome.wait}ms`);
		await sleep(outcome.wait);
	}
}

//#endregion
export { DEFAULT_MAX_RETRY_AFTER_MS, DEFAULT_TIMEOUT_MS, defaultSleep, requestJson };