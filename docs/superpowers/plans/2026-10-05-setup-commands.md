# Setup commands: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (chosen: native/inline). Steps use checkbox syntax.

**Goal:** `admobctl setup` (status, login, project list/use, apis, guided) plus a read-only MCP tool `admobctl_setup_status`, so that every setup problem names one `admobctl …` command.

**Architecture:** new `src/core/setup/` (features, Cloud REST client, gcloud handoff, status, steps). `auth/doctor.ts` is extended rather than rewritten. Error fixes across core move from gcloud lines to `admobctl setup …` commands. The CLI and MCP only call core.

**Spec:** `docs/superpowers/specs/2026-10-05-setup-commands-design.md`

**Open item resolved (2026-10-05, live read-only probe):** Resource Manager `projects:search` and Service Usage `services.get` both return 200 with the user's ADC token and **no** `x-goog-user-project` header. So `cloud.ts` sends no quota header, and `setup project list` works before a quota project exists (spec option a).

## Global Constraints
- Core-only logic. cli/mcp never import each other. stdout carries output only. TDD with `fakeFetch` and synthetic fixtures (placeholder IDs such as `example-project`, `pub-0000000000000001`).
- Every change is planned first and applied only with `--yes`. MCP stays read-only.
- Fix commands that apply changes include `--yes`. Read-only fix commands don't.
- `npm run check` passes after every task. Version 0.5.0 at the end.

## Review Focus
1. **A fix must never drop a scope the user already has.** For example, a write user following the payments fix. Login scopes = the union of stored, detected and requested features.
2. **No terminal (agent):** `setup` never prompts and never runs the browser login; it prints the next command.
3. **gcloud not installed / ADC file missing / ADC is a service account:** each gives one admobctl command.
4. **Service Usage enable is a long-running operation:** poll until `done`, surface `error`, and time out with a fix.
5. **OAuth mode:** `setup login` delegates to `auth login` with the right flags; the quota-project check is not needed.

---

### Task 1: features.ts
**Create:** `src/core/setup/features.ts`, `test/setup-features.test.ts`
**Produces:** `type Feature = "read" | "write" | "payments"`; `FEATURES: Record<Feature, { scopes: string[]; apis: string[] }>`; `parseFeatures(s?: string | string[]): Feature[]` (always includes `read`, sorted read, write, payments; unknown name → `usageError`); `featuresFromScopes(scopes: string[]): Feature[]`; `scopesFor(f: Feature[]): string[]` (order: admob.readonly, admob.monetization, adsense.readonly, cloud-platform); `apisFor(f): string[]`; `featureForService(service: string): Feature | undefined`.
- [ ] Tests: `parseFeatures("payments,write")` → `["read","write","payments"]`; `parseFeatures("x")` throws; `featuresFromScopes([readonly, adsense])` → `["read","payments"]`; `scopesFor(["read","payments"])` → `[readonly, adsense, cloud]`; `apisFor(["read","payments"])` → `["admob.googleapis.com","adsense.googleapis.com"]`; `featureForService("adsense.googleapis.com")` → `"payments"`. RED → implement → GREEN → commit.

### Task 2: cloud.ts (REST client)
**Create:** `src/core/setup/cloud.ts`, `test/setup-cloud.test.ts`, fixtures `test/fixtures/api/cloud-projects.json`, `serviceusage-operation-*.json`
**Produces:** `class CloudClient({ getToken, fetch?, sleep?, now? })` with:
- `listProjects(): Promise<Array<{ projectId: string; name: string }>>`: GET `cloudresourcemanager.googleapis.com/v3/projects:search` (paginated, ACTIVE only).
- `getProject(id): Promise<{ projectId: string; name: string }>`: GET `v3/projects/{id}`. 403/404 → `AdmobctlError("NOT_FOUND", …, fix: "admobctl setup project list")`.
- `serviceStates(project, services[]): Promise<Record<string, "ENABLED" | "DISABLED">>`: GET `serviceusage.googleapis.com/v1/projects/{p}/services/{s}` for each.
- `enableServices(project, services[]): Promise<void>`: POST `…/services:batchEnable` `{serviceIds}`, then poll `v1/{operation.name}` every 2 s until `done` (timeout 120 s → `AdmobctlError("API_ERROR", …, fix: "admobctl setup status")`). An `error` in the operation → `API_ERROR` carrying its message.
- Sends `authorization` only (no quota header, per the probe).
- [ ] Tests cover each method with `fakeFetch`, including an operation that is not done on the first poll and done on the second (no real sleeping), an operation error, and a timeout. RED → GREEN → commit.

### Task 3: gcloud handoff
**Modify:** `src/core/exec.ts` (option `interactive?: boolean` → `stdio: "inherit"`). **Create:** `src/core/setup/gcloud.ts`, `test/setup-gcloud.test.ts`
**Produces:** `loginArgs(scopes: string[]): string[]` → `["auth","application-default","login",`--scopes=${scopes.join(",")}`]`; `loginCommand(scopes): string` (`gcloud ` + args); `gcloudInstalled(exec): Promise<boolean>` (`gcloud --version`, false when spawn rejects or exits non-zero); `runLogin(exec, scopes): Promise<void>` (interactive; a non-zero exit → `AdmobctlError("AUTH_NO_CREDENTIALS", "gcloud sign-in did not complete", fix: "admobctl setup login --yes")`).
- [ ] Tests with a fake `Exec`: exact argv, `interactive: true` passed, installed true/false, a failing exit throws with the fix. Commit.

### Task 4: Fixes become admobctl commands, plus the "never guess" test
**Modify:** `src/core/errors.ts`, `src/core/client.ts` (write and payments scope, payments API), `src/core/auth/adc.ts`, `src/core/auth/doctor.ts` (fetchTokenInfo, scope, quota-project), and the existing tests that assert the old gcloud strings. **Create:** `test/fix-commands.test.ts`
New fixes:
- quota project missing → `admobctl setup project list`
- API not enabled → `admobctl setup apis --yes` (`--features payments` added when `featureForService(service) === "payments"`)
- scope missing (generic) → `admobctl setup login --yes`
- 401 / expired / no credentials / gcloud not runnable → `admobctl setup login --yes`
- ADC is a service account → `admobctl setup login --yes` (the plan explains that GOOGLE_APPLICATION_CREDENTIALS must be unset)
- write scope → `admobctl setup login --features write --yes`
- payments scope → `admobctl setup login --features payments --yes`
- payments API → `admobctl setup apis --features payments --yes`
- [ ] `fix-commands.test.ts`: for every auth/setup error code (AUTH_NO_CREDENTIALS, AUTH_SERVICE_ACCOUNT, AUTH_TOKEN_EXPIRED, AUTH_SCOPE_MISSING, AUTH_QUOTA_PROJECT_MISSING, API_NOT_ENABLED), produced through `diagnoseApiError` bodies, the AdmobClient write/listPayments paths and AdcTokenProvider failures, assert that `fix` matches `/^admobctl setup /`. RED → update code and old assertions → GREEN → commit.

### Task 5: Status core (doctor extension), `features` in config
**Modify:** `src/core/config.ts` (`features?: string[]` on the profile; `setProfileValue(…, "features", "write,payments")` stores a parsed list), `src/core/auth/doctor.ts` (Check gains `fix_command?`; new check ids `"features"` and `"apis"`; DoctorDeps gains `features?: Feature[]` and `serviceStates?: () => Promise<Record<string, string>>`; scope check → for stored features whose scopes are missing: warn, fix `admobctl setup login --features <missing> --yes`; apis check → missing APIs: fail, fix `admobctl setup apis --yes`; quota-project fix → `admobctl setup project list`). Every check sets `fix_command = fix` when the fix starts with `admobctl `. **Create:** `src/core/setup/status.ts`: `setupStatus(svc, deps: { fetch?, exec? }): Promise<{ ok: boolean; checks: Check[]; next_command?: string }>`. It builds DoctorDeps from the service (moved out of program.ts) plus features from the profile and serviceStates via CloudClient on the quota project. `next_command` = the first failing (or else warning) check's `fix_command`.
- [ ] Tests: doctor with features `[read, payments]` and a token without adsense → features warn with `--features payments` fix; serviceStates `{adsense: DISABLED}` → apis fail with `admobctl setup apis --yes`; `fix_command` is set only for admobctl fixes; `next_command` picks the first fail. Config round-trip of `features`. Commit.

### Task 6: Setup steps (core)
**Create:** `src/core/setup/steps.ts`, `test/setup-steps.test.ts`
**Produces:**
- `interface StepResult { step: "login" | "project" | "apis"; status: "done" | "applied" | "planned" | "needs-input"; summary: string[]; next_command?: string }`
- `planLogin(ctx, requested: Feature[]): Promise<StepResult & { scopes: string[] }>`. Union of stored, detected (tokeninfo; empty when there are no credentials) and requested features. `done` if the token already has every scope. Otherwise `planned` with summary `gcloud auth application-default login --scopes=…` and next_command `admobctl setup login [--features …] --yes`. In OAuth mode the summary is `admobctl auth login [--write] [--payments]`.
- `applyLogin(ctx, plan)`: ADC → `gcloudInstalled` (otherwise `AUTH_NO_CREDENTIALS` with the install link and fix `admobctl setup login --yes`), then `runLogin`; then stores the features in the profile. When `ctx.isTTY` is false it throws `USAGE` "the Google sign-in needs a browser; run this in a terminal: <gcloud command>". OAuth mode → existing `login()` with the write/payments flags.
- `planProject(ctx, id?)`: no id and a quotaProject set → `done`; no id → `needs-input`, next_command `admobctl setup project use <id> --yes`, summary listing up to 10 project IDs (from `listProjects`, or the Console link `https://console.cloud.google.com/projectcreate` when there are none); with id → `getProject` check → `planned` "Use <id> as quota project". `applyProject` stores `quotaProject`.
- `planApis(ctx, features)`: needs a quotaProject (else `needs-input` → `admobctl setup project list`); `serviceStates`; all enabled → `done`; otherwise `planned` "Enable a, b in <project>". `applyApis` → `enableServices`, audit entry `{ action: "Enable APIs", method: "POST", path: projects/<p>/services:batchEnable }`.
- `runSetup(ctx, { features, project, yes })`: login → project → apis, in order. Stops at the first step that is not done/applied and returns `{ steps, next_command }`. Applies only with yes. Login applies only when `isTTY`; otherwise it returns `needs-input` with the gcloud command for the user to run in a terminal, plus `next_command`.
- `ctx`: `{ svc, cloud: CloudClient, exec, isTTY, tokenInfo, configDir, profileName }`.
- [ ] Tests for each plan/apply with faked ctx states (signed out, write user adding payments keeps write, no project with 2 projects listed, API disabled → apply calls batchEnable and writes audit, no-TTY guided stops with next_command). Commit.

### Task 7: CLI
**Modify:** `src/cli/program.ts`, `src/cli/views.ts`; **Test:** `test/cli-setup.test.ts`
`setup` command (guided; options `--features`, `--project`, `--yes`), plus `setup status`, `setup login`, `setup project list`, `setup project use <id>` and `setup apis`. They render StepResult tables and print `Next: <next_command>` on stderr. `setup status` and `auth doctor` both use `setupStatus` (same view, gaining a `fix_command` column in JSON) and exit 1 on fail. In a TTY, guided setup adds closing hints: with several accounts and none chosen → `admobctl config set account <pub>`; finance/aliases → one optional `config set` hint line.
- [ ] Tests: `setup status --as json` has checks with `fix_command`; `setup apis` dry run prints the plan and "Dry run"; `setup apis --yes` calls batchEnable; `setup project use example-project --yes` stores quotaProject; `setup` with no TTY and no credentials → exit 0, stderr `Next: admobctl setup login --yes`. Commit.

### Task 8: MCP
**Modify:** `src/mcp/server.ts` (tool `admobctl_setup_status`, read-only, output `{ ok, checks[], next_command? }`; INSTRUCTIONS line: when anything fails with an auth/setup error, call admobctl_setup_status and run its `next_command` in the CLI exactly; never improvise gcloud commands), `test/mcp.test.ts` (tool list plus one call), `test/gen-eval-mocks.test.ts` (args plus routes) and regenerated mocks, `test/e2e.test.ts` (tool count 25). Commit.

### Task 9: Docs and release
README Authenticate section → `admobctl setup` first, features table, then the manual route; update the finance balance optional section to `admobctl setup --features payments --yes`. Skills (`admobctl/SKILL.md`, `references/commands.md`, finance skill) → setup commands and the setup_status rule. Version 0.5.0 (package.json, lockfile, both plugin.json). `npm run check`. Commit.
