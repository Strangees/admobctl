# `finance balance` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only `admobctl finance balance` command and `admobctl_finance_balance` MCP tool that report the publisher's current unpaid balance (which includes AdMob earnings) from the official AdSense Management API.

**Architecture:** `AdmobClient` gains one AdSense v2 read (`listPayments`), with AdSense-specific error mapping. A new core module `src/core/payments.ts` turns the API's formatted amount string into integer micros and builds a `FinanceBalance`. The CLI and MCP layers only call that core function, like every other `finance` command does. The extra `adsense.readonly` scope is optional and only needed by this command.

**Tech Stack:** TypeScript (ESM, Node ≥ 20), commander, @modelcontextprotocol/sdk + zod, vitest with `fakeFetch`, esbuild single-file bundle.

**Spec:** No spec doc. The design was agreed in the session on 2026-10-05, based on a live test of the user's account:
- `GET https://adsense.googleapis.com/v2/accounts/pub-…/payments` (scope `adsense.readonly`, API enabled in the quota project) returns `{"payments":[{"name":"accounts/pub-…/payments/unpaid","amount":"NOK <balance>"},{"name":"accounts/pub-…/payments/<yyyymmdd>","date":{…},"amount":"NOK <amount>"}]}`.
- The `unpaid` entry matched the AdMob UI balance. The paid entries **do not** include AdMob payouts, so paid history is out of scope.

## One-time user setup (what the live test needed, and how the tool guides each step)

| Manual step on 2026-10-05 | What admobctl does after this plan |
|---|---|
| `gcloud auth application-default login --scopes=…admob.readonly,…admob.monetization,…adsense.readonly,…cloud-platform` | A missing scope → `AUTH_SCOPE_MISSING` whose fix is `PAYMENTS_LOGIN_COMMAND`, plus "keep admob.monetization if you use write commands". OAuth-mode users get `admobctl auth login --payments`. `auth doctor` shows whether adsense.readonly is granted (Task 1). |
| `gcloud services enable adsense.googleapis.com --project <quota-project>` | `API_NOT_ENABLED` names `adsense.googleapis.com` and the quota project. The fix adds: run it as a project owner, add `--account <your Google account>` if gcloud is signed in as a service account (that's what happened in the test), and allow a minute to take effect (Task 1). |
| `--account <your Google account>` workaround | Same fix hint as above. |
| `x-goog-user-project: …` header | Already automatic: the client sends the profile's quota project, or the ADC quota project. It does **not** use `gcloud config get-value project` (which pointed at the wrong project in the test). |
| `curl …/v2/accounts` (sanity check) | Not needed. `finance balance` calls `accounts/<pub-id>/payments` directly. A missing AdSense account → `PAYMENTS_UNAVAILABLE` (Task 1). |
| `curl …/payments` | This is `admobctl finance balance` itself. |

README documents the three setup steps in order: login with scopes, enable the API, then run `admobctl finance balance` (Task 4).

## Global Constraints

- Business logic only in `src/core/`; `src/cli/` and `src/mcp/` call core and never import each other (enforced by `test/layering.test.ts`).
- Money is integer micros end to end; parse the amount string with integer arithmetic (no `parseFloat`), round only in output (`microsToAmount` / `formatMicros`).
- stdout is for command output; logging goes through `src/core/log.ts` to stderr.
- Every API/auth failure becomes an `AdmobctlError` with a `fix`.
- TDD: write the failing test in `test/` first, using `fakeFetch` and synthetic fixtures with placeholder IDs (`pub-0000000000000001`). No real publisher IDs, amounts, names or emails in committed files.
- MCP tools stay read-only (`annotations` const in `src/mcp/server.ts`).
- Exact scope: `https://www.googleapis.com/auth/adsense.readonly`. Exact API base: `https://adsense.googleapis.com/v2`.
- `npm run check` must pass at the end of every task.
- Work on a branch from up-to-date `main` (`git pull --ff-only` first; local main was behind `origin/main` v0.3.0 on 2026-10-05), e.g. `claude/finance-balance`.

## Review Focus

1. **Amount strings with a thousands separator or a negative sign** (`"NOK 12,345.67"`, `"-NOK 5.00"`, `"NOK -5.00"`). These should parse exactly to micros, not to NaN or a float-rounded value. Covered by Task 2 `parseAmount` tests.
2. **An account with no `unpaid` entry** (a new account, or just after a payout). The command should report 0 in the account currency with a note, not crash. Covered by Task 2.
3. **The AdSense API not enabled in the quota project.** The fix line must say `adsense.googleapis.com`, not `admob.googleapis.com`; today `diagnoseApiError` hardcodes AdMob. Covered by Task 1.
4. **Credentials without the adsense scope** (the default login for every existing user). The command should fail with a fix that keeps the AdMob scopes, and must not suggest the plain AdMob `LOGIN_COMMAND`. Covered by Task 1.
5. **A user who also uses the write commands and follows the scope fix.** `gcloud auth application-default login --scopes=…` *replaces* the granted scopes, so a fix that leaves out `admob.monetization` silently breaks their write commands. The fix text must tell them to keep it. Covered by Task 1.
6. **An AdMob publisher with no AdSense payments account** (the API returns 403 or 404 for `accounts/pub-…`). The command should show a clear `PAYMENTS_UNAVAILABLE` error, not "check you have access to this AdMob account". Covered by Task 1.

---

### Task 1: AdSense payments read in the client, with error mapping and the optional scope

**Files:**
- Modify: `src/core/errors.ts` (scope constants, `ErrorCode`, `diagnoseApiError` SERVICE_DISABLED branch)
- Modify: `src/core/client.ts` (base URL, type, `listPayments`, AdSense error mapping)
- Modify: `src/core/auth/doctor.ts` (scope summary)
- Modify: `src/core/auth/oauth.ts` (`buildAuthUrl` gets `payments?: boolean`), `src/core/auth/login.ts` (`LoginOptions.payments`), `src/cli/program.ts` (`auth login --payments`)
- Create: `test/fixtures/api/adsense-payments.json`
- Test: `test/errors.test.ts`, `test/client.test.ts`, `test/oauth.test.ts`, `test/doctor.test.ts`

**Interfaces:**
- Produces (errors.ts):
  - `export const ADSENSE_SCOPE = "https://www.googleapis.com/auth/adsense.readonly";`
  - `export const PAYMENTS_LOGIN_COMMAND = \`gcloud auth application-default login --scopes=${ADMOB_SCOPE},${ADSENSE_SCOPE},${CLOUD_PLATFORM_SCOPE}\`;`
  - `ErrorCode` gains `"PAYMENTS_UNAVAILABLE"`.
- Produces (client.ts):
  - `export const ADSENSE_API_BASE = "https://adsense.googleapis.com/v2";`
  - `export interface AdsensePayment { name: string; amount: string; date?: { year: number; month: number; day: number } }`
  - `AdmobClientOptions.adsenseBaseUrl?: string`
  - `AdmobClient.listPayments(account: string): Promise<AdsensePayment[]>`. `account` is accepted as `pub-…` or `accounts/pub-…` (use `accountName`). It is a single GET (the method has no pagination). Quota category `"account"`. Returns `[]` when the body has no `payments`.
- Produces (oauth.ts): `buildAuthUrl(o: { …; write?: boolean; payments?: boolean })`. The scope is `ADMOB_SCOPE`, plus `MONETIZATION_SCOPE` if `write`, plus `ADSENSE_SCOPE` if `payments`, joined by spaces.

- [ ] **Step 1: Write the failing tests**

`test/fixtures/api/adsense-payments.json` (synthetic):
```json
{
  "payments": [
    { "name": "accounts/pub-0000000000000001/payments/unpaid", "amount": "NOK 1,234.56" },
    { "name": "accounts/pub-0000000000000001/payments/20240521", "date": { "year": 2024, "month": 5, "day": 21 }, "amount": "NOK 700.00" }
  ]
}
```

`test/errors.test.ts`:
```ts
it("names the disabled service from ErrorInfo metadata", () => {
  const e = diagnoseApiError(403, {
    error: {
      code: 403,
      message: "AdSense Management API has not been used in project my-project before or it is disabled.",
      details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED",
        metadata: { consumer: "projects/my-project", service: "adsense.googleapis.com", serviceTitle: "AdSense Management API" } }],
    },
  });
  expect(e.code).toBe("API_NOT_ENABLED");
  expect(e.message).toBe("The AdSense Management API is not enabled in project my-project.");
  expect(e.fix).toBe("gcloud services enable adsense.googleapis.com --project my-project");
});
```
The existing AdMob SERVICE_DISABLED test must still pass unchanged (its fix stays `gcloud services enable admob.googleapis.com --project my-project`).

`test/client.test.ts` (build the client with `fakeFetch`, `getToken: async () => "t"`, `quotaProject: "qp"`, `sleep: noSleep`):
- `listPayments("pub-0000000000000001")` → GETs a URL equal to `https://adsense.googleapis.com/v2/accounts/pub-0000000000000001/payments`, sends `authorization: Bearer t` and `x-goog-user-project: qp`, and returns the fixture's two entries.
- A 403 whose body has ErrorInfo reason `ACCESS_TOKEN_SCOPE_INSUFFICIENT` → rejects with `code: "AUTH_SCOPE_MISSING"` and `fix` containing `PAYMENTS_LOGIN_COMMAND` and `admobctl auth login --payments`.
- A plain 403 (`{ error: { code: 403, message: "The caller does not have permission", status: "PERMISSION_DENIED" } }`) and a plain 404 → both reject with `code: "PAYMENTS_UNAVAILABLE"`; the message contains `pub-0000000000000001`.
- A 403 SERVICE_DISABLED body with `service: "adsense.googleapis.com"` and consumer `projects/qp` → `code: "API_NOT_ENABLED"`. Its `fix` starts with `gcloud services enable adsense.googleapis.com --project qp` and contains `--account` and `minute`.
- The scope-missing `fix` above also contains `admob.monetization` (the "keep it" hint).

`test/doctor.test.ts` (next to "says when write commands are enabled…"):
- With scopes `[admob.readonly, adsense.readonly]`, `checks.scope.summary` matches `/adsense\.readonly \(finance balance enabled\)/`.

`test/oauth.test.ts`:
- `buildAuthUrl({ …, payments: true })` → `scope` is `"…/admob.readonly …/adsense.readonly"`. With both `write` and `payments`, the scope has all three, AdMob first.

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run test/errors.test.ts test/client.test.ts test/oauth.test.ts`
Expected: FAIL. `listPayments` is not a function, the adsense message/fix are wrong, and the scope lacks adsense.

- [ ] **Step 3: Implement**
- `errors.ts`: add the constants and the error code. In the SERVICE_DISABLED branch, use `info?.metadata?.serviceTitle ?? "AdMob API"` in the message and `info?.metadata?.service ?? "admob.googleapis.com"` in the fix.
- `client.ts`: add `"adsense"` to `ApiVersion`. Resolve the base in `request` as v1 → `baseUrl ?? API_BASE`, v1beta → `betaBaseUrl ?? API_BASE_BETA`, adsense → `adsenseBaseUrl ?? ADSENSE_API_BASE`. Wrap `listPayments` errors in a `paymentsError(err, account)`, next to `betaError`:
  - `AUTH_SCOPE_MISSING` → same code. Message: `"finance balance needs the adsense.readonly scope, which your credentials do not include."` Fix: `` `${PAYMENTS_LOGIN_COMMAND}  (add ,${MONETIZATION_SCOPE} to --scopes if you use the write commands; or: admobctl auth login --payments)` ``
  - `API_NOT_ENABLED` → same code, message unchanged. Fix: `` `${err.fix}  (run it as a project owner: if gcloud is signed in as a service account, add --account <your Google account>; allow a minute to take effect)` ``. The generic `diagnoseApiError` fix stays as it is, so the existing AdMob test keeps passing.
  - `PERMISSION_DENIED` or `NOT_FOUND` → `PAYMENTS_UNAVAILABLE`. Message: `` `No Google payments (AdSense) account was found for ${account}, so the unpaid balance is unavailable.` `` Fix: `"Check AdMob → Payments in the web UI. If your balance shows there, run admobctl auth doctor and make sure you signed in as the AdMob account owner."`
  - Anything else passes through.
- `auth/doctor.ts`: after the monetization suffix in the scope summary, append `", adsense.readonly (finance balance enabled)"` when `ADSENSE_SCOPE` is granted.
- `oauth.ts` / `login.ts` / `program.ts`: thread `payments` through like `write`. The CLI option is `--payments`, described as "also grant adsense.readonly, needed by finance balance".

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run test/errors.test.ts test/client.test.ts test/oauth.test.ts test/login.test.ts test/doctor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/errors.ts src/core/client.ts src/core/auth/doctor.ts src/core/auth/oauth.ts src/core/auth/login.ts src/cli/program.ts test/errors.test.ts test/client.test.ts test/oauth.test.ts test/doctor.test.ts test/fixtures/api/adsense-payments.json
git commit -m "Read AdSense payments in the client, with an optional adsense scope"
```

---

### Task 2: Core `financeBalance` and amount parsing

**Files:**
- Create: `src/core/payments.ts`
- Test: `test/payments.test.ts`

**Interfaces:**
- Consumes: `AdmobClient.listPayments`, `AdsensePayment` (Task 1); `AdmobService.account(): Promise<PublisherAccount>` and `svc.client` (existing).
- Produces:
  - `export function parseAmount(text: string): { currency: string; micros: number }`
  - `export interface FinanceBalance { account: string; currency: string; unpaid: number; unpaidMicros: number; notes: string[] }`. `account` is the publisher ID (`pub-…`); `unpaid` is `microsToAmount(unpaidMicros)`.
  - `export const BALANCE_NOTE = "Unpaid balance from Google payments (AdSense Management API). It includes AdMob earnings. Payment history is not available: the API leaves out AdMob payouts.";`
  - `export async function financeBalance(svc: AdmobService): Promise<FinanceBalance>`

- [ ] **Step 1: Write the failing tests** in `test/payments.test.ts`

`parseAmount`:
```ts
expect(parseAmount("NOK 98.76")).toEqual({ currency: "NOK", micros: 98_760_000 });
expect(parseAmount("NOK 12,345.67")).toEqual({ currency: "NOK", micros: 12_345_670_000 });
expect(parseAmount("USD 0.5")).toEqual({ currency: "USD", micros: 500_000 });
expect(parseAmount("EUR 7")).toEqual({ currency: "EUR", micros: 7_000_000 });
expect(parseAmount("-NOK 5.00")).toEqual({ currency: "NOK", micros: -5_000_000 });
expect(parseAmount("NOK -5.00")).toEqual({ currency: "NOK", micros: -5_000_000 });
expect(() => parseAmount("kr 5,00")).toThrow(/Unrecognized payment amount/);
expect(() => parseAmount("NOK 1.2345678")).toThrow(/Unrecognized payment amount/);
```
The thrown error is an `AdmobctlError` with code `API_ERROR` and a `fix`. Its message quotes the input, which is fine because it is only shown to the account owner.

`financeBalance` (service built like `test/finance.test.ts`: `fakeFetch` with `"GET /v1/accounts?"` → `accounts.json` and `"GET /v2/accounts/"` → the response under test):
- With the `adsense-payments.json` fixture: `{ account: "pub-0000000000000001", currency: "NOK", unpaid: 1234.56, unpaidMicros: 1_234_560_000, notes: [BALANCE_NOTE] }`. The AdSense call URL contains `/v2/accounts/pub-0000000000000001/payments`.
- With `{ payments: [] }` and with `{}`: `unpaid: 0`, `unpaidMicros: 0`, `currency: "NOK"` (from the AdMob account's `currencyCode`), and `notes` contains `"No unpaid balance reported."` as well as `BALANCE_NOTE`.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/payments.test.ts`
Expected: FAIL. The module `../src/core/payments.js` does not exist.

- [ ] **Step 3: Implement `src/core/payments.ts`**

`parseAmount` uses `^(-)?([A-Z]{3}) (-)?(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,6}))?$`. Strip the commas and build micros as `BigInt(int) * 1_000_000n + BigInt(frac.padEnd(6, "0"))`. Check it with `Number.isSafeInteger` (as `parseMicros` does), then negate if either sign group matched. `financeBalance` finds the entry whose `name` ends with `/payments/unpaid`. Paid entries are ignored.

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run test/payments.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/payments.ts test/payments.test.ts
git commit -m "Add financeBalance: unpaid balance in micros from AdSense payments"
```

---

### Task 3: CLI `finance balance` and MCP `admobctl_finance_balance`

**Files:**
- Modify: `src/cli/views.ts` (add `financeBalanceView`), `src/cli/program.ts` (the `finance balance` subcommand after `forecast`)
- Modify: `src/mcp/server.ts` (register the tool after `admobctl_finance_forecast`; one `INSTRUCTIONS` line)
- Modify: `test/gen-eval-mocks.test.ts` (args `admobctl_finance_balance: {}` plus a `GET /v2/accounts/` route serving `adsense-payments.json`). Regenerate `evals/mocks/admobctl/` with `npm run eval:mocks`.
- Test: `test/cli.test.ts`, `test/mcp.test.ts`

**Interfaces:**
- Consumes: `financeBalance`, `FinanceBalance`, `BALANCE_NOTE` (Task 2).
- Produces: `export function financeBalanceView(b: FinanceBalance): Output`. Its table has columns `account` ("Account") and `unpaid` (`` `Unpaid (${b.currency})` ``, right-aligned, `toFixed(2)`), with one row, and `notes: b.notes`.

- [ ] **Step 1: Write the failing tests**
- `test/cli.test.ts`: follow the file's existing pattern for `finance month` (`test/forecast.test.ts` shows how `finance forecast` is driven).
  - `finance balance --as json` writes JSON to stdout with `unpaid: 1234.56`, `currency: "NOK"` and `account: "pub-0000000000000001"`.
  - The default summary output contains `1234.56` and `Unpaid (NOK)`.
  - When the AdSense route returns a scope-insufficient 403, the command exits non-zero and stderr contains `admobctl auth login --payments`.
- `test/mcp.test.ts`:
  - Add `"admobctl_finance_balance"` to the expected tool list. The existing loop already asserts it is read-only.
  - Add a test: `callTool({ name: "admobctl_finance_balance", arguments: {} })` with a `"GET /v2/accounts/"` route → `structuredContent` has `unpaid: 1234.56`, `currency: "NOK"` and a `notes` array containing `BALANCE_NOTE`.

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run test/cli.test.ts test/mcp.test.ts`
Expected: FAIL. The command and the tool are unknown.

- [ ] **Step 3: Implement**
- CLI: `finance.command("balance")`. Description: "Current unpaid balance from Google payments (includes AdMob earnings; needs the adsense.readonly scope)". `--as` choices are `summary`, `csv` and `json`, exactly like `forecast`, and the output goes through `emitFinance(cmd, o.as, view, () => view)`.
- MCP tool: title "AdMob unpaid balance". Description: "Current unpaid balance Google will pay out (AdSense Management API; includes AdMob earnings), in the account's payment currency. Not a monthly figure and not payment history. Needs a one-time extra sign-in scope; if it fails, pass the Fix line on." `inputSchema: { ...accountArg }`. `outputSchema: loose({ account: z.string(), currency: z.string(), unpaid: z.number(), notes: z.array(z.string()) })`. Use the `annotations` const.
- `INSTRUCTIONS`: add the line ``- For "what is my balance / what will Google pay me" use admobctl_finance_balance (unpaid balance; it needs an extra scope, so pass its Fix line on if it fails).``
- Eval mocks: add the args and the route, run `npm run eval:mocks`, and commit the regenerated files.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run test/cli.test.ts test/mcp.test.ts test/layering.test.ts test/gen-eval-mocks.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli src/mcp test/cli.test.ts test/mcp.test.ts test/gen-eval-mocks.test.ts evals/mocks/admobctl
git commit -m "Add finance balance command and admobctl_finance_balance MCP tool"
```

---

### Task 4: Docs, skills and full check

**Files:**
- Modify: `README.md` (Usage: `admobctl finance balance`. Authenticate gets an "Optional: unpaid balance" subsection with the setup steps in order: (1) the login command with all four scopes `admob.readonly,admob.monetization,adsense.readonly,cloud-platform`, saying admob.monetization is only needed for writes, or `admobctl auth login --payments`; (2) `gcloud services enable adsense.googleapis.com --project <quota-project> --account <your Google account>`; (3) `admobctl finance balance`, or `admobctl auth doctor` to confirm the scope. Plus the MCP tool list; the line "All earnings are estimates…" gains "`finance balance` shows the current unpaid balance; payment history is not in any API.")
- Modify: `skills/admobctl/SKILL.md`, `skills/admobctl/references/commands.md`, `skills/admobctl-finance/SKILL.md` (when to use `finance balance`/`admobctl_finance_balance`; that it is the unpaid balance, not a month's earnings; payment history still comes from the AdMob UI).

- [ ] **Step 1: Make the doc edits above.** Use placeholder IDs only, and no real amounts.
- [ ] **Step 2: Run the full check**

Run: `npm run check`
Expected: typecheck clean, bundle built, all tests pass.

- [ ] **Step 3: Commit**

```bash
git add README.md skills dist/admobctl.mjs
git commit -m "Document finance balance and the optional adsense scope"
```

Release (version bump in `package.json`, lockfile and both `plugin.json` files) is left to the user, per `.claude/CLAUDE.md`.
