import { describe, expect, it } from "vitest";
import { requestJson } from "../src/core/http.js";
import { AdmobctlError } from "../src/core/errors.js";
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
