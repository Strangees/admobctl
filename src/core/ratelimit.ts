import { defaultSleep } from "./http.js";
import { log } from "./log.js";

/** The AdMob API's per-project quota categories (https://developers.google.com/admob/api/quotas). */
export type QuotaCategory = "account" | "inventory" | "reporting";

const MINUTE = 60_000;
export const QUOTAS: Record<QuotaCategory, number> = { account: 900, inventory: 120, reporting: 900 };

/**
 * Sliding-window limiter: at most `limit` calls start in any `windowMs`. Slots are reserved
 * synchronously, so concurrent callers queue up instead of all slipping through at once.
 * Best effort: the real quota is per Google Cloud project, shared with other clients.
 */
export class RateLimiter {
  private starts: number[] = [];

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Wait until a call may start. `sleep` is the caller's, so tests with a fake sleep never block. */
  async take(sleep: (ms: number) => Promise<void> = defaultSleep): Promise<void> {
    const t = this.now();
    this.starts = this.starts.filter((s) => s > t - this.windowMs);
    const at = this.starts.length >= this.limit ? this.starts[this.starts.length - this.limit]! + this.windowMs : t;
    this.starts.push(at);
    this.starts.sort((a, b) => a - b);
    if (at > t) {
      log.debug(`rate limit: waiting ${at - t}ms for a free slot`);
      await sleep(at - t);
    }
  }
}

export type Limiters = Record<QuotaCategory, RateLimiter>;

export function createLimiters(now?: () => number): Limiters {
  const make = (c: QuotaCategory) => new RateLimiter(QUOTAS[c], MINUTE, now);
  return { account: make("account"), inventory: make("inventory"), reporting: make("reporting") };
}

/** Shared by every client in the process: the quota belongs to the project, not to one account. */
export const processLimiters: Limiters = createLimiters();
