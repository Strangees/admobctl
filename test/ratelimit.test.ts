import { describe, expect, it } from "vitest";
import { AdmobClient } from "../src/core/client.js";
import { createLimiters, RateLimiter } from "../src/core/ratelimit.js";
import { fakeFetch, fixture, jsonResponse } from "./helpers.js";

function clock() {
  let t = 0;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    advance: (ms: number) => (t += ms),
    slept,
  };
}

describe("RateLimiter", () => {
  it("lets calls through until the window is full, then waits for the oldest to expire", async () => {
    const c = clock();
    const rl = new RateLimiter(2, 60_000, c.now);
    await rl.take(c.sleep);
    c.advance(10_000);
    await rl.take(c.sleep);
    expect(c.slept).toEqual([]);
    await rl.take(c.sleep);
    expect(c.slept).toEqual([50_000]);
  });

  it("reserves slots for concurrent callers so the window is never exceeded", async () => {
    // All four start at t=0, before any of them has slept.
    const slept: number[] = [];
    const rl = new RateLimiter(2, 1000, () => 0);
    const sleep = async (ms: number) => void slept.push(ms);
    await Promise.all([rl.take(sleep), rl.take(sleep), rl.take(sleep), rl.take(sleep)]);
    expect(slept).toEqual([1000, 1000]);
  });

  it("uses the published AdMob API quotas per category", () => {
    const l = createLimiters(() => 0);
    expect(l.inventory.limit).toBe(120);
    expect(l.reporting.limit).toBe(900);
    expect(l.account.limit).toBe(900);
  });
});

describe("AdmobClient rate limiting", () => {
  it("counts apps and ad unit lists against the inventory quota", async () => {
    const c = clock();
    const f = fakeFetch({
      "GET /apps": () => jsonResponse({ apps: [] }),
      "GET /adUnits": () => jsonResponse({ adUnits: [] }),
      "GET /v1/accounts?": () => jsonResponse(fixture("accounts.json")),
    });
    const limiters = createLimiters(c.now);
    const client = new AdmobClient({ getToken: async () => "t", fetch: f.fetch, sleep: c.sleep, limiters });
    for (let i = 0; i < 60; i++) {
      await client.listApps("pub-1");
      await client.listAdUnits("pub-1");
    }
    expect(c.slept).toEqual([]);
    await client.listAccounts();
    expect(c.slept).toEqual([]);
    await client.listApps("pub-1");
    expect(c.slept).toHaveLength(1);
  });
});
