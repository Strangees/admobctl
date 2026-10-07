import { AdmobctlError, diagnoseApiError, type DiagnoseHints } from "./errors.js";
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
  /** Awaited before every attempt, retries included (e.g. to take a rate-limiter slot). */
  beforeAttempt?: () => Promise<void>;
  /** Turns a failed response into the error to throw. Default: diagnoseApiError (AdMob wording). */
  diagnose?: (status: number, body: unknown, hints: DiagnoseHints) => AdmobctlError;
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

/** What one attempt produced, once its response (including the body) has been fully read. */
type AttemptOutcome =
  | { kind: "ok"; status: number; body: unknown }
  | { kind: "fail"; status: number; body: unknown; retryAfterMs?: number }
  | { kind: "retry"; status: number; wait: number };

/**
 * One attempt: fetch and read the body, all under the caller's (already combined) signal, so the
 * per-attempt timeout also covers a server that sends headers and then stalls mid-body.
 * Network errors, timeouts and caller aborts propagate as throws.
 */
async function attemptOnce(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  canRetry: boolean,
  backoff: number,
  maxRetryAfterMs: number,
): Promise<AttemptOutcome> {
  const res = await doFetch(url, init);
  if (res.ok) return { kind: "ok", status: res.status, body: await readBody(res) };

  if (!isRetryableStatus(res.status)) return { kind: "fail", status: res.status, body: await readBody(res) };

  // Parsed even on the last attempt, so the diagnosed error can say how long the server asked us to wait.
  const retryAfter = retryAfterMs(res);
  if (!canRetry) return { kind: "fail", status: res.status, body: await readBody(res), retryAfterMs: retryAfter };
  if (retryAfter !== undefined && retryAfter > maxRetryAfterMs) {
    log.debug(`HTTP ${res.status}; Retry-After ${retryAfter}ms exceeds cap ${maxRetryAfterMs}ms; not retrying`);
    return { kind: "fail", status: res.status, body: await readBody(res), retryAfterMs: retryAfter };
  }
  await res.body?.cancel().catch(() => {});
  return { kind: "retry", status: res.status, wait: retryAfter ?? backoff };
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
    await opts.beforeAttempt?.();
    const backoff = base * 2 ** attempt + Math.floor(Math.random() * base * 0.25);
    const timer = new AbortController();
    const timeoutId = setTimeout(
      () => timer.abort(new Error(`Request timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    let outcome: AttemptOutcome;
    const started = Date.now();
    try {
      // The timer stays armed until the body has been fully read, not just until headers arrive.
      const signal = combineSignals(timer.signal, init.signal);
      outcome = await attemptOnce(doFetch, url, { ...init, signal }, attempt < retries, backoff, maxRetryAfterMs);
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

    // URL and status only: headers carry the access token and are never logged.
    log.debug(`${init.method ?? "GET"} ${url} → ${outcome.status} (${Date.now() - started}ms)`);
    if (outcome.kind === "ok") return outcome.body as T;
    if (outcome.kind === "fail") {
      log.debug(`response: ${(typeof outcome.body === "string" ? outcome.body : JSON.stringify(outcome.body) ?? "").slice(0, 2000)}`);
      throw (opts.diagnose ?? diagnoseApiError)(outcome.status, outcome.body, { retryAfterMs: outcome.retryAfterMs });
    }
    log.debug(`HTTP ${outcome.status}; retrying in ${outcome.wait}ms`);
    await sleep(outcome.wait);
  }
}
