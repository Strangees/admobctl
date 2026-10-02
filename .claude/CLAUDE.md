# admobctl — contributor notes

- `src/core/` is the only place with business logic. `src/cli/` and `src/mcp/` call `AdmobService`
  (src/core/service.ts) and must never call each other.
- Money is integer micros end to end; round only in output (`formatMicros`, `microsToAmount`).
- stdout is for command output (and the MCP protocol). All logging goes through `src/core/log.ts` → stderr.
- Every API/auth failure becomes an `AdmobctlError` with a `fix` command (src/core/errors.ts).
- TDD: add a failing test in `test/` first. Tests use `fakeFetch` + fixtures in `test/fixtures/api/`
  (synthetic, placeholder IDs only). Real recorded responses go in `test/fixtures/private/` (gitignored).
- Open-source hygiene: no real publisher IDs, app names, earnings or emails in committed files.
- `npm run check` = typecheck + tests + bundle (`dist/admobctl.mjs`, single file, no runtime deps).
