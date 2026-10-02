/**
 * Record real AdMob API responses for the golden finance tests.
 *
 *   npm run record-fixtures -- --month 2026-09 --expect <booked total> \
 *                              --range 2026-01:2026-09 --expect-range <booked total> [--profile name]
 *
 * --expect / --expect-range are the totals you actually booked; the test checks
 * admobctl reproduces them. Output goes to test/fixtures/private/ (gitignored).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { financeMonth, financeRange } from "../src/core/finance.js";
import { AdmobService } from "../src/core/service.js";
import { recordingFetch } from "../test/cassette.js";
import type { GoldenCase } from "../test/golden.test.js";

const { values } = parseArgs({
  options: {
    month: { type: "string" },
    expect: { type: "string" },
    range: { type: "string" },
    "expect-range": { type: "string" },
    profile: { type: "string" },
    account: { type: "string" },
  },
});

if (!values.month && !values.range) {
  console.error("usage: npm run record-fixtures -- --month YYYY-MM --expect 0.00 [--range YYYY-MM:YYYY-MM --expect-range 0.00]");
  process.exit(2);
}

const outDir = new URL("../test/fixtures/private/", import.meta.url);
mkdirSync(outDir, { recursive: true });
const cases: GoldenCase[] = [];
let failures = 0;

async function record(kind: "month" | "range", period: string, expectTotal: string | undefined) {
  const rec = recordingFetch(fetch);
  const svc = AdmobService.create({ profile: values.profile, account: values.account }, { fetch: rec.fetch });
  const total =
    kind === "month"
      ? (await financeMonth(svc, period)).total
      : (await financeRange(svc, ...(period.split(":") as [string, string]))).total;
  const account = (await svc.account()).publisherId;
  const cassette = `cassette-${kind}-${period.replace(":", "_")}.json`;
  writeFileSync(new URL(cassette, outDir), `${JSON.stringify(rec.cassette(), null, 2)}\n`, { mode: 0o600 });
  const got = total.toFixed(2);
  if (expectTotal === undefined) {
    console.error(`${kind} ${period}: ${got} (no --expect given; not added to golden.json)`);
    return;
  }
  const ok = got === Number(expectTotal).toFixed(2);
  if (!ok) failures++;
  console.error(`${kind} ${period}: admobctl ${got}, booked ${expectTotal} ${ok ? "✓" : "✗ MISMATCH"}`);
  cases.push({ kind, period, expectTotal: Number(expectTotal).toFixed(2), cassette, account });
}

if (values.month) await record("month", values.month, values.expect);
if (values.range) await record("range", values.range, values["expect-range"]);
writeFileSync(new URL("golden.json", outDir), `${JSON.stringify({ cases }, null, 2)}\n`, { mode: 0o600 });
console.error(`wrote ${cases.length} golden case(s) to test/fixtures/private/`);
process.exitCode = failures ? 1 : 0;
