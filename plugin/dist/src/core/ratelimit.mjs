import { log } from "./log.mjs";
import { defaultSleep } from "./http.mjs";

//#region src/core/ratelimit.ts
const MINUTE = 6e4;
const QUOTAS = {
	account: 900,
	inventory: 120,
	reporting: 900
};
/**
* Sliding-window limiter: at most `limit` calls start in any `windowMs`. Slots are reserved
* synchronously, so concurrent callers queue up instead of all slipping through at once.
* Best effort: the real quota is per Google Cloud project, shared with other clients.
*/
var RateLimiter = class {
	limit;
	windowMs;
	now;
	starts = [];
	constructor(limit, windowMs, now = Date.now) {
		this.limit = limit;
		this.windowMs = windowMs;
		this.now = now;
	}
	/** Wait until a call may start. `sleep` is the caller's, so tests with a fake sleep never block. */
	async take(sleep = defaultSleep) {
		const t = this.now();
		this.starts = this.starts.filter((s) => s > t - this.windowMs);
		const at = this.starts.length >= this.limit ? this.starts[this.starts.length - this.limit] + this.windowMs : t;
		this.starts.push(at);
		this.starts.sort((a, b) => a - b);
		if (at > t) {
			log.debug(`rate limit: waiting ${at - t}ms for a free slot`);
			await sleep(at - t);
		}
	}
};
function createLimiters(now) {
	const make = (c) => new RateLimiter(QUOTAS[c], MINUTE, now);
	return {
		account: make("account"),
		inventory: make("inventory"),
		reporting: make("reporting")
	};
}
/** Shared by every client in the process: the quota belongs to the project, not to one account. */
const processLimiters = createLimiters();

//#endregion
export { QUOTAS, RateLimiter, createLimiters, processLimiters };