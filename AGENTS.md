# AGENTS.md

Guidance for coding agents (Codex, Claude Code and others) working in this repository. `.claude/CLAUDE.md` imports
this file.

admobctl is a TypeScript CLI, MCP server and Claude Code/Codex plugin for the Google AdMob API. Running it needs
Node.js 20+; developing it (vitest) needs 22.12+.

## Commands

```bash
npm run check                          # typecheck + bundle + all tests; must pass before a PR
npx vitest run test/mcp.test.ts        # one test file
npx vitest run test/mcp.test.ts -t "setup_status"   # tests whose name matches
npm run eval:mocks                     # regenerate plugin/evals/mocks/ after changing MCP tool output
npm run eval -- --runs 3               # plugin evals against the mocks (uses Claude credentials)
```

There is no linter; `tsc --noEmit` (strict, `noUncheckedIndexedAccess`) covers `src/`, `test/` and `scripts/`.

## Rules

- `src/core/` is the only place with business logic. `src/cli/` and `src/mcp/` call `AdmobService`
  (src/core/service.ts) and must never import each other, not even through another module; `src/core/` and
  `src/output/` import neither (`test/layering.test.ts` enforces it).
- Money is integer micros end to end; round only in output (`formatMicros`, `microsToAmount`).
- stdout is for command output (and the MCP protocol). All logging goes through `src/core/log.ts` → stderr; an
  interactive child process gets its stdout mapped to stderr (`src/core/exec.ts`).
- Every API/auth failure becomes an `AdmobctlError` with a `fix` command (src/core/errors.ts). Fixes must be runnable
  `admobctl …` commands; `profileCommand` adds `--profile` when a non-default profile is in use.
- The MCP server is read-only. Writes (src/core/write.ts) are built as a `WritePlan` that the CLI prints; nothing is
  sent without `--yes`, and applied writes go to the audit log.
- TDD: add a failing test in `test/` first. Tests use `fakeFetch` + fixtures in `test/fixtures/api/`
  (synthetic, placeholder IDs only). Real recorded responses go in `test/fixtures/private/` (gitignored).
- Open-source hygiene: no real publisher IDs, app names, earnings or emails in committed files
  (`test/release.test.ts` fails on real-looking publisher IDs and non-`example.com` emails).
- When a command, flag or MCP tool changes, update the README, `plugin/README.md` and `plugin/skills/` (including
  `plugin/skills/admobctl/references/commands.md`).
- Commit the rebuilt `plugin/dist/admobctl.mjs` and any `plugin/evals/mocks/` changes; CI fails when either is stale.
- Release = bump the version in `package.json`, the lockfile and both `plugin.json` files, then merge to `main`; CI tags
  and publishes it (README, "CI and releases"). Anything users should get (anything under `plugin/`) needs a bump. A
  bump also changes `plugin/evals/mocks/admobctl/admobctl_finance_export.md` (it embeds the version), so rerun
  `eval:mocks`.

## Architecture

- **Composition root:** `src/bin.ts` passes real stdout/stderr, `isTTY` (stdout: picks table vs JSON output) and
  `stdinIsTTY` (stdin: gates the interactive sign-in) into `run(argv, io)` in `src/cli/program.ts`, and injects the
  MCP server as `runMcp` so the CLI never imports `src/mcp`. `run` returns the exit code: 0 ok, 1 failure (also a
  failing `check`, `lint` or `setup status`), 2 usage error.
- **CLI:** one commander program in `src/cli/program.ts`; `src/cli/views.ts` turns core results into an `Output`
  (columns, rows, notes) that `src/output/format.ts` renders as table, JSON, CSV or markdown.
- **AdmobService** (`src/core/service.ts`) resolves everything user-facing: profile (`~/.admobctl/config.json`, or
  `ADMOBCTL_HOME`), credentials, publisher account and app aliases, and memoizes account/apps/ad units per instance.
  `AdmobService.create(opts, deps)` takes `configDir`, `tokenProvider`, `fetch`, `sleep`, `exec` and `now`; these are
  the seams every test injects.
- **API layer:** `AdmobClient` (`src/core/client.ts`) on `src/core/http.ts` (retries 429/5xx, honours Retry-After)
  talks to AdMob v1, v1beta (Google allowlists some accounts; a v1beta permission error is not a setup mistake) and
  AdSense v2 (unpaid balance). `diagnoseApiError` maps API errors to `AdmobctlError` codes and fixes.
- **Auth and setup:** a profile uses gcloud ADC (default, `src/core/auth/adc.ts`) or the user's own OAuth client
  (`admobctl auth login`; tokens in the macOS Keychain, elsewhere a file in the config dir). Features
  `read`/`write`/`payments` map to scopes and Cloud APIs in `src/core/setup/features.ts`. `src/core/setup/` holds
  `setup status` (every check with a `fix_command`, plus one `next_command`) and the guided login → quota project →
  APIs steps.
- **MCP:** `src/mcp/server.ts` registers zod-typed, read-only tools that return `structuredContent` plus a JSON text
  mirror, trimmed to `DEFAULT_MAX_ROWS`/`MAX_TEXT_CHARS`. Services are cached per account for `SERVICE_TTL_MS`;
  `admobctl_setup_status` always builds a fresh one. The `INSTRUCTIONS` string there is what agents are told.
- **Finance:** AdMob earnings are estimates (reconcile against AdMob Payments). `finance export` writes the Revenue
  Journal format, specified separately in `spec/` with its own versioning and changelog.
- **Plugin:** `plugin/` is exactly what Claude Code and Codex install; the repo root is the marketplace
  (`.claude-plugin/marketplace.json`, source `./plugin`, which Codex reads too). Both manifests in `plugin/` run the
  committed bundle `plugin/dist/admobctl.mjs` (esbuild, single file, no runtime deps, `__ADMOBCTL_VERSION__` injected
  at build and by vitest). Keep `package.json`, lockfiles, `CLAUDE.md` and dev files out of `plugin/`: a lockfile there
  makes every install run `npm ci`, and Anthropic's directory scans the whole folder (`test/release.test.ts` guards
  both). `plugin/README.md` is the directory listing text and must disclose every host, program and file admobctl
  uses. `plugin/evals/` holds `claude plugin eval` cases (the eval dir must be inside the plugin) whose MCP results
  come from `plugin/evals/mocks/`, generated by `test/gen-eval-mocks.test.ts` from synthetic fixtures (one mocked call
  per MCP tool; a test fails when a tool has none).

## Tests

- `fakeFetch` (test/helpers.ts) routes on `"METHOD url-substring"` (longest match wins) and records each call's URL,
  headers and body; `fixture()` reads `test/fixtures/api/`.
- CLI tests call `run([...], { stdout, stderr, isTTY, stdinIsTTY, service: deps })`; MCP tests connect a client to
  `createMcpServer` over `InMemoryTransport`.
- `test/e2e.test.ts` runs the built bundle (skipped without `dist/`); `test/golden.test.ts` replays private cassettes
  from `npm run record-fixtures` (skipped without them).
- CI runs the tests on Node 22 and 24. Node 20 (vitest needs 22.12+) only smoke-tests the bundle:
  `scripts/smoke-bundle.mjs` (`--help` for every command) and the MCP tool list (`scripts/dump-tools.mjs`).
  `npm run typecheck` also checks `src/` against Node 20's types (`tsconfig.node20.json`, with `@types/node@20`
  installed as `@types-node20/node`), so a newer Node.js API in `src/` fails it.
