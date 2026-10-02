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

  it("does not retry 4xx client errors", async () => {
    const s = sequence([jsonResponse({ error: { code: 400, message: "bad dimension" } }, 400), jsonResponse({})]);
    const err = (await requestJson("https://x/y", {}, s).catch((e) => e)) as AdmobctlError;
    expect(err.code).toBe("API_ERROR");
    expect(err.message).toContain("bad dimension");
    expect(s.count()).toBe(1);
  });
});
