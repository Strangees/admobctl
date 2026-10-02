import { AdmobctlError, diagnoseApiError } from "./errors.js";
import { log } from "./log.js";

export interface HttpOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Number of retries after the first attempt. */
  retries?: number;
  baseDelayMs?: number;
  /** Per-attempt timeout; a stalled request is aborted and retried. Default 30s. */
  timeoutMs?: number;
  /**
   * Longest server-requested Retry-After we will sleep for. If a 429/5xx asks us to wait longer,
   * stop retrying and throw the diagnosed error immediately (fail fast with "retry later") rather
   * than silently sleeping. A value exactly equal to the cap is still honoured. Default 60s.
   */
  maxRetryAfterMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RETRY_AFTER_MS = 60_000;

/** Combine the caller's signal (if any) with the per-attempt timeout signal. */
function combineSignals(timeout: AbortSignal, caller?: AbortSignal | null): AbortSignal {
  if (!caller) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([caller, timeout]);
  // Fallback for Node < 20.3: forward both into one controller.
  const ctl = new AbortController();
  const forward = (s: AbortSignal) => {
    if (s.aborted) ctl.abort(s.reason);
    else s.addEventListener("abort", () => ctl.abort(s.reason), { once: true });
  };
  forward(caller);
  forward(timeout);
  return ctl.signal;
}

export const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function retryAfterMs(res: Response): number | undefined {
  const h = res.headers.get("retry-after");
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return secs * 1000;
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** fetch + JSON with exponential backoff on 429/5xx and transient network errors. */
export async function requestJson<T = unknown>(url: string, init: RequestInit, opts: HttpOptions = {}): Promise<T> {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const retries = opts.retries ?? 4;
  const base = opts.baseDelayMs ?? 500;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetryAfterMs = opts.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;

  for (let attempt = 0; ; attempt++) {
    const backoff = base * 2 ** attempt + Math.floor(Math.random() * base * 0.25);
    const timer = new AbortController();
    const timeoutId = setTimeout(
      () => timer.abort(new Error(`Request timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    let res: Response;
    try {
      res = await doFetch(url, { ...init, signal: combineSignals(timer.signal, init.signal) });
    } catch (err) {
      // The caller cancelled: propagate as-is, never retry.
      if (init.signal?.aborted) throw err;
      const timedOut = timer.signal.aborted;
      const host = new URL(url).host;
      if (attempt >= retries) {
        if (timedOut) {
          throw new AdmobctlError(
            "API_ERROR",
            `Request to ${host} timed out after ${timeoutMs}ms (${attempt + 1} attempts).`,
            { cause: err, fix: "Check your connection and retry." },
          );
        }
        throw new AdmobctlError("API_ERROR", `Network error calling ${host}: ${(err as Error).message}`, {
          cause: err,
          fix: "Check your internet connection and retry.",
        });
      }
      log.debug(`${timedOut ? `timeout after ${timeoutMs}ms` : `network error (${(err as Error).message})`}; retrying in ${backoff}ms`);
      await sleep(backoff);
      continue;
    } finally {
      clearTimeout(timeoutId);
    }

    if (res.ok) return (await readBody(res)) as T;

    if (isRetryableStatus(res.status) && attempt < retries) {
      const retryAfter = retryAfterMs(res);
      if (retryAfter !== undefined && retryAfter > maxRetryAfterMs) {
        log.debug(`HTTP ${res.status}; Retry-After ${retryAfter}ms exceeds cap ${maxRetryAfterMs}ms; not retrying`);
        throw diagnoseApiError(res.status, await readBody(res));
      }
      const wait = retryAfter ?? backoff;
      log.debug(`HTTP ${res.status}; retrying in ${wait}ms`);
      await res.body?.cancel().catch(() => {});
      await sleep(wait);
      continue;
    }
    throw diagnoseApiError(res.status, await readBody(res));
  }
}
