/**
 * Golden finance tests against real recorded data. Skipped unless you have run
 *   npm run record-fixtures -- --month YYYY-MM --expect <booked total> [--range YYYY-MM:YYYY-MM --expect-range <total>]
 * which writes cassettes and the expected (booked) figures to test/fixtures/private/.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { financeMonth, financeRange } from "../src/core/finance.js";
import { AdmobService } from "../src/core/service.js";
import { replayFetch, type Cassette } from "./cassette.js";
import { noSleep } from "./helpers.js";

export interface GoldenCase {
  kind: "month" | "range";
  /** YYYY-MM, or YYYY-MM:YYYY-MM for ranges */
  period: string;
  /** The booked total, as a decimal string, e.g. "102.45". */
  expectTotal: string;
  cassette: string;
  account: string;
}

const dir = new URL("./fixtures/private/", import.meta.url);
const goldenFile = new URL("golden.json", dir);
const cases: GoldenCase[] = existsSync(goldenFile) ? JSON.parse(readFileSync(goldenFile, "utf8")).cases : [];

describe.skipIf(cases.length === 0)("golden finance (recorded private data)", () => {
  for (const c of cases) {
    it(`${c.kind} ${c.period} totals ${c.expectTotal}`, async () => {
      const cassette = JSON.parse(readFileSync(new URL(c.cassette, dir), "utf8")) as Cassette;
      const svc = AdmobService.create(
        { account: c.account },
        {
          configDir: mkdtempSync(join(tmpdir(), "admobctl-golden-")),
          tokenProvider: { mode: "adc", getToken: async () => "replay", quotaProject: () => undefined },
          fetch: replayFetch(cassette),
          sleep: noSleep,
          now: () => new Date(cassette.recordedAt),
        },
      );
      if (c.kind === "month") {
        const m = await financeMonth(svc, c.period);
        expect(m.total.toFixed(2)).toBe(c.expectTotal);
        // Per-app split must add up to the booked total.
        expect(m.apps.reduce((s, a) => s + Math.round(a.earnings * 100), 0)).toBe(Math.round(m.total * 100));
      } else {
        const [from, to] = c.period.split(":") as [string, string];
        const r = await financeRange(svc, from, to);
        expect(r.total.toFixed(2)).toBe(c.expectTotal);
      }
    });
  }
});
