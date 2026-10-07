import { afterEach, describe, expect, it, vi } from "vitest";
import { requestJson } from "../src/core/http.js";
import { AdmobctlError } from "../src/core/errors.js";
import { log } from "../src/core/log.js";
import { jsonResponse } from "./helpers.js";

function sequence(responses: Array<Response | Error>) {
  let i = 0;
  const delays: number[] = [];
  const fetch = (async () => {
    const r = responses[i++];
    if (!r) throw new Error("no more responses");
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof globalThis.fetch;
  const sleep = async (ms: number) => {
    delays.push(ms);
  };
  return { fetch, sleep, delays, count: () => i };
}

/** A fetch that never resolves on its own; it only settles by rejecting when its signal aborts. */
function hangingFetch() {
  const signals: AbortSignal[] = [];
  const fetch = ((_url: string, init: RequestInit = {}) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init.signal;
      if (!signal) return; // no signal: hangs forever
      signals.push(signal);
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })) as unknown as typeof globalThis.fetch;
  return { fetch, signals, count: () => signals.length };
}

/**
 * A fetch that resolves with headers at once, then stalls mid-body: the body stream enqueues part of
 * a JSON payload and never closes. Like real fetch, aborting the request signal errors the body
 * stream with the signal's reason.
 */
function stallingBodyFetch(status = 200) {
  const signals: AbortSignal[] = [];
  const fetch = (async (_url: string, init: RequestInit = {}) => {
    const signal = init.signal;
    if (signal) signals.push(signal);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"partial": '));
        if (!signal) return; // no signal: stalls forever
        if (signal.aborted) return controller.error(signal.reason);
        signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
      },
    });
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, signals, count: () => signals.length };
}

describe("requestJson", () => {
  it("returns parsed JSON on success", async () => {
    const s = sequence([jsonResponse({ ok: true })]);
    await expect(requestJson("https://x/y", {}, s)).resolves.toEqual({ ok: true });
  });

  it("retries 429 and 5xx with growing backoff, then succeeds", async () => {
    const s = sequence([jsonResponse({}, 429), jsonResponse({}, 503), jsonResponse({ ok: 1 })]);
    await expect(requestJson("https://x/y", {}, s)).resolves.toEqual({ ok: 1 });
    expect(s.count()).toBe(3);
    expect(s.delays).toHaveLength(2);
    expect(s.delays[1]!).toBeGreaterThan(s.delays[0]!);
  });

  it("ignores a Retry-After of 0 or less and backs off as usual", async () => {
    const s = sequence([
      jsonResponse({}, 503, { "retry-after": "0" }),
      jsonResponse({}, 503, { "retry-after": "-30" }),
      jsonResponse({}, 503, { "retry-after": new Date(Date.now() - 60_000).toUTCString() }),
      jsonResponse({ ok: 1 }),
    ]);
    await expect(requestJson("https://x/y", {}, { ...s, baseDelayMs: 500 })).resolves.toEqual({ ok: 1 });
    expect(s.delays).toHaveLength(3);
    expect(s.delays[0]!).toBeGreaterThanOrEqual(500);
    expect(s.delays[1]!).toBeGreaterThanOrEqual(1000);
    expect(s.delays[2]!).toBeGreaterThanOrEqual(2000);
  });

  it("waits at least the backoff when Retry-After asks for less", async () => {
    const s = sequence([jsonResponse({}, 503), jsonResponse({}, 503), jsonResponse({}, 429, { "retry-after": "1" }), jsonResponse({ ok: 1 })]);
    await requestJson("https://x/y", {}, { ...s, baseDelayMs: 500 });
    expect(s.delays[2]!).toBeGreaterThanOrEqual(2000);
  });

  it("does not promise a wait of about 1 second when the last 429 said Retry-After: 0", async () => {
    const s = sequence([jsonResponse({ error: { message: "slow down" } }, 429, { "retry-after": "0" })]);
    const err = (await requestJson("https://x/y", {}, { ...s, retries: 0 }).catch((e) => e)) as AdmobctlError;
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.fix).toBe("Wait a minute and retry, or narrow the report.");
  });

  it("honours Retry-After seconds", async () => {
    const s = sequence([jsonResponse({}, 429, { "retry-after": "7" }), jsonResponse({ ok: 1 })]);
    await requestJson("https://x/y", {}, s);
    expect(s.delays).toEqual([7000]);
  });

  it("fails fast with RATE_LIMITED when Retry-After seconds exceed the cap, instead of sleeping", async () => {
    const s = sequence([jsonResponse({ error: { message: "slow down" } }, 429, { "retry-after": "3600" }), jsonResponse({ ok: 1 })]);
    const err = (await requestJson("https://x/y", {}, s).catch((e) => e)) as AdmobctlError;
    expect(err).toBeInstanceOf(AdmobctlError);
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.message).toContain("slow down");
    expect(err.fix).toMatch(/1 hour/);
    expect(s.count()).toBe(1);
    expect(s.delays).toEqual([]);
  });

  it("fails fast when a Retry-After HTTP-date is beyond the cap", async () => {
    const later = new Date(Date.now() + 3_600_000).toUTCString();
    const s = sequence([jsonResponse({}, 429, { "retry-after": later }), jsonResponse({ ok: 1 })]);
    const err = (await requestJson("https://x/y", {}, s).catch((e) => e)) as AdmobctlError;
    expect(err).toBeInstanceOf(AdmobctlError);
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.fix).toMatch(/1 hour/);
    expect(s.count()).toBe(1);
    expect(s.delays).toEqual([]);
  });

  it("takes the Retry-After cap from maxRetryAfterMs", async () => {
    const s = sequence([jsonResponse({}, 429, { "retry-after": "7" }), jsonResponse({ ok: 1 })]);
    const err = (await requestJson("https://x/y", {}, { ...s, maxRetryAfterMs: 5000 }).catch((e) => e)) as AdmobctlError;
    expect(err).toBeInstanceOf(AdmobctlError);
    expect(err.code).toBe("RATE_LIMITED");
    expect(s.count()).toBe(1);
    expect(s.delays).toEqual([]);
  });

  it("retries transient network errors", async () => {
    const s = sequence([new TypeError("fetch failed"), jsonResponse({ ok: 1 })]);
    await expect(requestJson("https://x/y", {}, s)).resolves.toEqual({ ok: 1 });
  });

  it("gives up after the retry budget and raises a diagnosed error", async () => {
    const s = sequence(Array.from({ length: 10 }, () => jsonResponse({ error: { message: "slow down" } }, 429)));
    const err = (await requestJson("https://x/y", {}, { ...s, retries: 2 }).catch((e) => e)) as AdmobctlError;
    expect(err).toBeInstanceOf(AdmobctlError);
    expect(err.code).toBe("RATE_LIMITED");
    expect(s.count()).toBe(3);
  });

  it("reflects the last Retry-After in the fix when retries run out on a 429", async () => {
    const s = sequence(Array.from({ length: 10 }, () => jsonResponse({ error: { message: "slow down" } }, 429, { "retry-after": "30" })));
    const err = (await requestJson("https://x/y", {}, { ...s, retries: 2 }).catch((e) => e)) as AdmobctlError;
    expect(err).toBeInstanceOf(AdmobctlError);
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.message).toContain("slow down");
    expect(err.fix).toMatch(/30 seconds/);
    expect(s.count()).toBe(3);
    expect(s.delays).toEqual([30_000, 30_000]);
  });

  it("fails on a 2xx whose body is not JSON (a Wi-Fi sign-in page) instead of returning the text, and does not retry", async () => {
    const page = "<html><head><title>Sign in to Wi-Fi</title></head><body><form>…</form></body></html>";
    const s = sequence([new Response(page, { status: 200, headers: { "content-type": "text/html" } }), jsonResponse({ ok: 1 })]);
    const err = (await requestJson("https://admob.googleapis.com/v1/accounts", {}, s).catch((e) => e)) as AdmobctlError;
    expect(err).toBeInstanceOf(AdmobctlError);
    expect(err.code).toBe("API_ERROR");
    expect(err.message).toContain("AdMob API");
    expect(err.message).toContain("not JSON");
    expect(err.message).toContain("Sign in to Wi-Fi");
    expect(err.message).not.toContain("<form>");
    expect(err.fix).toMatch(/network/i);
    expect(s.count()).toBe(1);
  });

  it("fails on a 200 with an empty body", async () => {
    const s = sequence([new Response("", { status: 200 })]);
    const err = (await requestJson("https://admob.googleapis.com/v1/accounts", {}, s).catch((e) => e)) as AdmobctlError;
    expect(err).toBeInstanceOf(AdmobctlError);
    expect(err.code).toBe("API_ERROR");
    expect(err.message).toMatch(/empty response/);
  });

  it("accepts 204 No Content without a body", async () => {
    const s = sequence([new Response(null, { status: 204 })]);
    await expect(requestJson("https://x/y", {}, s)).resolves.toBeUndefined();
  });

  it.each([
    ["https://adsense.googleapis.com/v2/accounts/pub-1/payments", "AdSense Management API error 500"],
    ["https://serviceusage.googleapis.com/v1/projects/p/services/x", "Service Usage API error 500"],
    ["https://cloudresourcemanager.googleapis.com/v3/projects/p", "Cloud Resource Manager API error 500"],
    ["https://admob.googleapis.com/v1/accounts", "AdMob API error 500"],
  ])("labels an error from %s by its API", async (url, label) => {
    const s = sequence([jsonResponse({ error: { code: 500, message: "boom" } }, 500)]);
    const err = (await requestJson(url, {}, { ...s, retries: 0 }).catch((e) => e)) as AdmobctlError;
    expect(err.message).toBe(`${label}: boom`);
  });

  it("does not retry 4xx client errors", async () => {
    const s = sequence([jsonResponse({ error: { code: 400, message: "bad dimension" } }, 400), jsonResponse({})]);
    const err = (await requestJson("https://x/y", {}, s).catch((e) => e)) as AdmobctlError;
    expect(err.code).toBe("API_ERROR");
    expect(err.message).toContain("bad dimension");
    expect(s.count()).toBe(1);
  });

  it("aborts a stalled request after timeoutMs, retries it, then raises a readable error", async () => {
    const h = hangingFetch();
    const delays: number[] = [];
    const sleep = async (ms: number) => {
      delays.push(ms);
    };
    const err = (await requestJson("https://admob.googleapis.com/v1/x", {}, {
      fetch: h.fetch,
      sleep,
      retries: 2,
      timeoutMs: 5,
    }).catch((e) => e)) as AdmobctlError;
    expect(h.count()).toBe(3);
    expect(delays).toHaveLength(2);
    expect(err).toBeInstanceOf(AdmobctlError);
    expect(err.code).toBe("API_ERROR");
    expect(err.message).toMatch(/timed out after 5ms/);
    expect(err.message).toContain("admob.googleapis.com");
    expect(err.fix).toMatch(/connection/i);
  });

  it("times out a body that stalls after headers arrive, retries it, then raises a readable error", { timeout: 2000 }, async () => {
    const s = stallingBodyFetch();
    const delays: number[] = [];
    const sleep = async (ms: number) => {
      delays.push(ms);
    };
    const err = (await requestJson("https://admob.googleapis.com/v1/x", {}, {
      fetch: s.fetch,
      sleep,
      retries: 2,
      timeoutMs: 5,
    }).catch((e) => e)) as AdmobctlError;
    expect(s.count()).toBe(3);
    expect(delays).toHaveLength(2);
    expect(err).toBeInstanceOf(AdmobctlError);
    expect(err.code).toBe("API_ERROR");
    expect(err.message).toMatch(/timed out after 5ms/);
    expect(err.message).toContain("admob.googleapis.com");
    expect(err.fix).toBe("Check your connection and retry.");
  });

  it("times out an error body that stalls on the final attempt instead of hanging", { timeout: 2000 }, async () => {
    const s = stallingBodyFetch(400);
    const err = (await requestJson("https://admob.googleapis.com/v1/x", {}, {
      fetch: s.fetch,
      sleep: async () => {},
      retries: 0,
      timeoutMs: 5,
    }).catch((e) => e)) as AdmobctlError;
    expect(s.count()).toBe(1);
    expect(err).toBeInstanceOf(AdmobctlError);
    expect(err.code).toBe("API_ERROR");
    expect(err.message).toMatch(/timed out after 5ms \(1 attempts\)/);
    expect(err.fix).toBe("Check your connection and retry.");
  });

  it("does not retry when the caller's own signal aborts", async () => {
    const h = hangingFetch();
    const caller = new AbortController();
    const p = requestJson("https://x/y", { signal: caller.signal }, { fetch: h.fetch, sleep: async () => {}, timeoutMs: 10_000 });
    caller.abort(new Error("cancelled by caller"));
    await expect(p).rejects.toThrow("cancelled by caller");
    expect(h.count()).toBe(1);
  });
});

describe("requestJson beforeAttempt", () => {
  it("runs before every attempt, retries included, so a rate limiter sees each request", async () => {
    const s = sequence([jsonResponse({}, 503), jsonResponse({}, 429), jsonResponse({ ok: true })]);
    let calls = 0;
    const r = await requestJson("https://x.test/a", {}, { fetch: s.fetch, sleep: s.sleep, beforeAttempt: async () => void calls++ });
    expect(r).toEqual({ ok: true });
    expect(calls).toBe(3);
  });
});

describe("requestJson verbose logging", () => {
  afterEach(() => {
    log.setVerbose(false);
    vi.restoreAllMocks();
  });

  function captureStderr() {
    const lines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    return lines;
  }

  it("logs each request's method, URL, status and time to stderr with -v", async () => {
    const lines = captureStderr();
    log.setVerbose(true);
    const { fetch, sleep } = sequence([jsonResponse({ ok: 1 })]);
    await requestJson("https://admob.googleapis.com/v1/accounts", { method: "GET", headers: { authorization: "Bearer secret" } }, { fetch, sleep });
    const out = lines.join("");
    expect(out).toMatch(/GET https:\/\/admob\.googleapis\.com\/v1\/accounts → 200 \(\d+ms\)/);
    expect(out).not.toContain("secret");
  });

  it("logs the API's error body on a failed request with -v", async () => {
    const lines = captureStderr();
    log.setVerbose(true);
    const { fetch, sleep } = sequence([jsonResponse({ error: { code: 400, message: "Request contains an invalid argument." } }, 400)]);
    await requestJson("https://admob.googleapis.com/v1beta/x:generate", { method: "POST", body: "{}" }, { fetch, sleep }).catch(() => {});
    const out = lines.join("");
    expect(out).toMatch(/POST https:\/\/admob\.googleapis\.com\/v1beta\/x:generate → 400/);
    expect(out).toContain("Request contains an invalid argument.");
  });

  it("logs nothing without -v", async () => {
    const lines = captureStderr();
    const { fetch, sleep } = sequence([jsonResponse({ ok: 1 })]);
    await requestJson("https://admob.googleapis.com/v1/accounts", { method: "GET" }, { fetch, sleep });
    expect(lines.join("")).toBe("");
  });
});
