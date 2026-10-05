# Setup commands: design

Date: 2026-10-05 · Status: approved in conversation, pending spec review · Ships with `finance balance` in one PR (v0.5.0, branch `claude/finance-balance`)

## Goal

A user, or an agent acting for them, gets from nothing to a working admobctl by running **only admobctl commands**. Every problem admobctl reports names exactly one next command to run, so nobody has to work out gcloud flags, scope lists, projects or accounts.

Success criteria:
- Starting signed out, with no quota project and the AdSense API off, a user reaches a working `finance balance` by following only what `admobctl setup` / `setup status` print. (This is the walkthrough we did by hand on 2026-10-05.)
- Every `fix` that admobctl emits is an `admobctl …` command. The only exceptions are the browser sign-in and the Cloud Console link for creating a project, and both are reached through an admobctl command. A test enforces this.
- An agent never blocks on an interactive prompt.

## Non-goals

- Features that only exist in the AdMob web UI (test devices, consent messages, crawler access).
- Creating Cloud projects from the CLI (`project create`). With no project, the fix is the Cloud Console link followed by `setup project use <id>`.
- New subcommands for the account, aliases or finance settings. `config set` already covers them, and setup points at it.
- Setup changes made from MCP. The MCP server stays read-only.

## Decisions (from the conversation)

1. **MCP role:** diagnose only. `admobctl_setup_status` returns checks, each with a `fix_command`. The agent runs that command in the CLI, where the user sees it.
2. **Execution:** hybrid. Sign-in uses `gcloud auth application-default login` (it creates the ADC credentials). Everything else is done through Google REST APIs (Service Usage, Cloud Resource Manager) with the user's own token, never with gcloud's active account. That account may be a service account, as it was on 2026-10-05.
3. **Input:** flags first. At a terminal, guided `setup` asks for missing values. Without a terminal (an agent) it never prompts: it stops and prints the exact command with the missing flag, plus valid choices where it knows them.
4. **Changes:** each step prints a plan and applies it only with `--yes`, like the existing write commands. Applied changes go to the existing audit log.

## Features

A *feature* bundles the scopes and APIs one capability needs:

| Feature | Scopes | APIs |
|---|---|---|
| `read` (always) | `admob.readonly`, `cloud-platform` | `admob.googleapis.com` |
| `write` | + `admob.monetization` | none |
| `payments` | + `adsense.readonly` | + `adsense.googleapis.com` |

`--features write,payments` adds to `read`. The selected features are stored in the profile as `features`. **Detected features** are the ones whose scopes the current token has. Sign-in always asks for the union of stored, detected and requested features, so a fix never drops a scope the user already has (the `--write` lesson from the finance-balance review).

## Commands

```
admobctl setup status                         read-only; same checks as auth doctor plus feature/API checks; each gap has fix_command
admobctl setup login [--features …] [--yes]   plan: the gcloud ADC login with the union of scopes. --yes at a terminal runs it
                                              (gcloud opens the browser). Without a terminal: prints the command instead
admobctl setup project list                   projects the user can access (Resource Manager projects.search)
admobctl setup project use <id> [--yes]       checks access, then stores quotaProject in the profile
admobctl setup apis [--features …] [--yes]    enables every API the selected features need (Service Usage batchEnable, polls the operation)
admobctl setup [--features …] [--project <id>] [--yes]
                                              guided: login → project → apis → (terminal only: account, aliases, finance prompts
                                              that write via config) → status. Skips finished steps. Stops with exactly one next command
```

`auth doctor` stays and gains the new checks and `fix_command`. `setup status` is the same report.

## Checks and fixes

Each check returns `{ id, status: ok|warn|fail|skip, summary, fix?, fix_command? }`. `fix_command` is always a runnable `admobctl …` line. `fix` stays for backward compatibility.

| Check | Failing → fix_command |
|---|---|
| gcloud installed (ADC mode only) | `admobctl setup login` (its plan carries the install link, or the alternative `admobctl auth login --client-id …`) |
| credentials | `admobctl setup login --yes` |
| scopes, per stored feature | `admobctl setup login --features <missing> --yes` |
| quota project | `admobctl setup project list` when none is set; `admobctl setup project use <id> --yes` when one is known |
| API enabled, per feature | `admobctl setup apis --yes` |
| account (several, none chosen) | `admobctl config set account <pub-id>` (lists the choices) |
| apps / beta (existing) | unchanged (AdMob UI action / account manager) |

Errors raised elsewhere move to the same commands. Today they print gcloud lines; after this change:
- `AUTH_SCOPE_MISSING` (any path) → `admobctl setup login --features <needed> --yes`
- `API_NOT_ENABLED` → `admobctl setup apis --yes` (the feature is inferred from the service name)
- `AUTH_QUOTA_PROJECT_MISSING` → `admobctl setup project list`
- `AUTH_TOKEN_EXPIRED` → `admobctl setup login --yes`

## Architecture

New `src/core/setup/` (core only; the CLI and MCP call it):
- `features.ts`: the feature table, `parseFeatures`, `featuresFromScopes`, `scopesFor`, `apisFor`.
- `cloud.ts`: REST client for Service Usage v1 (`services.get`, `services:batchEnable`, `operations.get`) and Resource Manager v3 (`projects.search`, `projects.get`). It uses the existing `TokenProvider` and `requestJson`, polls long-running operations, and maps errors to `AdmobctlError`.
- `steps.ts`: `login`, `project`, `apis` steps, each `plan(state) → { actions, needs }` and `apply(actions)`, plus `runSetup` for the guided order.
- `gcloud.ts`: builds the login argv and runs it with inherited stdio, through the existing `Exec` (extended so it can run interactively).

`auth/doctor.ts` is extended rather than rewritten: new checks plus `fix_command`. `setup status` calls it.

## Open item to resolve first (plan task 1)

Do Service Usage and Resource Manager accept the user's ADC token **before any quota project is set**, which is the first step for a new user? A live read-only probe on the user's account, with permission, decides between:
(a) the calls work without `x-goog-user-project`, so `setup project list` runs first; or
(b) they need a quota project, so `setup project use <id>` takes the id from the user (the Console link lists projects) and checks it with `projects.get` using that id as the quota project.

## Testing

- Unit tests for features, scope detection, and each step's `plan()` against faked states (signed out, missing scope, no project, API off, several accounts).
- `cloud.ts` with `fakeFetch` and synthetic fixtures, including operation polling and permission errors.
- gcloud handoff through an injected `Exec`: the exact argv, plus the no-terminal path that returns the command.
- "Never guess" test: run every error mapper and setup check on representative inputs and assert each `fix_command` (and each migrated `fix`) starts with `admobctl `, apart from the listed exceptions.
- MCP: `admobctl_setup_status` is read-only and has `fix_command` on failing checks; update the tool-list test and the eval mocks.
- Live end-to-end run following the test prompt, starting from a signed-out state with the AdSense API off.

## Docs and release

The README's Authenticate section becomes `admobctl setup` plus a short explanation of features. Skills and MCP instructions: "call `admobctl_setup_status`; run exactly its `fix_command` in the CLI; never improvise gcloud commands." Version 0.5.0 in `package.json`, the lockfile and both `plugin.json` files. One PR, together with `finance balance`.
