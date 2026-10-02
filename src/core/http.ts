import { AdmobctlError, diagnoseApiError } from "./errors.js";
import { log } from "./log.js";

export interface HttpOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Number of retries after the first attempt. */
  retries?: number;
  baseDelayMs?: number;
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

  for (let attempt = 0; ; attempt++) {
    const backoff = base * 2 ** attempt + Math.floor(Math.random() * base * 0.25);
    let res: Response;
    try {
      res = await doFetch(url, init);
    } catch (err) {
      if (attempt >= retries) {
        throw new AdmobctlError("API_ERROR", `Network error calling ${new URL(url).host}: ${(err as Error).message}`, {
          cause: err,
          fix: "Check your internet connection and retry.",
        });
      }
      log.debug(`network error (${(err as Error).message}); retrying in ${backoff}ms`);
      await sleep(backoff);
      continue;
    }

    if (res.ok) return (await readBody(res)) as T;

    if (isRetryableStatus(res.status) && attempt < retries) {
      const wait = retryAfterMs(res) ?? backoff;
      log.debug(`HTTP ${res.status}; retrying in ${wait}ms`);
      await res.body?.cancel().catch(() => {});
      await sleep(wait);
      continue;
    }
    throw diagnoseApiError(res.status, await readBody(res));
  }
}
