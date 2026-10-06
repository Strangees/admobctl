# Contributing

Bug reports, fixes and new commands are welcome. For anything bigger than a fix, open an issue first so the shape can
be agreed on before you write it.

## Setup

Developing admobctl needs Node.js 22.12+ (running it needs only 20+). You do not need an AdMob account: the tests run
against synthetic API responses.

```bash
git clone https://github.com/Strangees/admobctl && cd admobctl
npm install
npm run check   # typecheck + bundle + tests
```

## Code layout

- `src/core/` holds all business logic. `src/cli/` (the commands) and `src/mcp/` (the MCP server) both call
  `AdmobService` in `src/core/service.ts` and never import each other; `test/layering.test.ts` enforces this.
- Money is integer micros end to end. Round only in output (`formatMicros`, `microsToAmount`).
- stdout is for command output and the MCP protocol. Log through `src/core/log.ts`, which writes to stderr.
- Every API or auth failure becomes an `AdmobctlError` with a `fix` command the user can run (`src/core/errors.ts`).
- The MCP server is read-only. Commands that change AdMob or a Google Cloud project exist only in the CLI and are dry
  runs unless `--yes`.

## Tests

Write a failing test in `test/` first. Tests use `fakeFetch` from `test/helpers.ts` with fixtures in
`test/fixtures/api/`.

**Fixtures and examples are synthetic.** Use placeholder IDs (`pub-0000000000000001`,
`ca-app-pub-0000000000000001~1111111111`), made-up app names and amounts, and `example.com` addresses. Never commit a
real publisher ID, app name, earnings figure or email address; `test/release.test.ts` fails on real-looking publisher
IDs and on email addresses outside `example.com`. `npm run record-fixtures` records responses from your own account
into `test/fixtures/private/`, which is gitignored.

## Pull requests

1. `npm run check` passes.
2. **Commit the rebuilt bundle.** `dist/admobctl.mjs` is committed because Claude Code and Codex install the plugin
   straight from git. `npm run check` rebuilds it, and CI fails when the committed bundle does not match the source.
3. If you changed what an MCP tool returns, run `npm run eval:mocks` and commit `evals/mocks/`; CI checks these too.
4. Update the README and `skills/` when a command, flag or MCP tool changes.

Leave the version number alone: the maintainer bumps it when releasing (README, "CI and releases").

`AGENTS.md` has the same rules in short form for coding agents such as Codex and Claude Code (`CLAUDE.md` imports it).
