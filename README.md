# admobctl

A fast command-line tool for the Google AdMob API, with an agent plugin for Claude Code and Codex.

> **Unofficial.** admobctl is not affiliated with, endorsed by, or sponsored by Google. "AdMob" is a trademark of Google LLC.

- Human-friendly app aliases (`my-game-ios`) instead of resource IDs
- Network and mediation reports as table, JSON, CSV or Markdown
- Monthly finance output you can book directly (per app, journal rows)
- Monetization insights: eCPM/RPM, fill and show rate, weakest units, swings vs the previous period
- `admobctl mcp`: the same capabilities as typed, read-only MCP tools for Claude Code, Codex and other MCP clients

## Install

Requires Node.js 20 or later.

```bash
git clone https://github.com/Strangees/admobctl && cd admobctl
npm install && npm run build
npm link   # puts `admobctl` on your PATH
```

## Authenticate

admobctl reuses your gcloud **Application Default Credentials** (ADC) when they are present:

```bash
gcloud auth application-default login \
  --scopes=https://www.googleapis.com/auth/admob.readonly,https://www.googleapis.com/auth/cloud-platform
gcloud auth application-default set-quota-project <PROJECT_ID>   # a project with the AdMob API enabled
gcloud services enable admob.googleapis.com --project <PROJECT_ID>
admobctl auth doctor
```

`auth doctor` checks credentials, scope, quota project, API access and account, and prints the exact fix for anything that is wrong.

The AdMob API does **not** accept service accounts; you must sign in as a Google user with access to the AdMob account.

**No gcloud?** Use your own OAuth client instead. In Google Cloud Console, create a *Desktop app* OAuth client in a project with the AdMob API enabled, then:

```bash
admobctl auth login --client-id <id> --client-secret <secret>
```

The refresh token is stored in the macOS Keychain (on other OSes, a `0600` file in `~/.admobctl/`). `admobctl auth logout` revokes it.

## Usage

```bash
admobctl accounts list
admobctl apps list                                   # shows the alias for each app
admobctl ad-units list --app my-game-ios
admobctl report network --from 2026-09 --by app
admobctl report network --from 2026-09-01 --to 2026-09-30 --by app,country \
  --metrics earnings,impressions,rpm --filter country=NO,SE --output csv
admobctl report mediation --from 2026-09 --by ad-source

admobctl finance month 2026-09                       # per app + total
admobctl finance month 2026-09 --as journal          # paste-ready journal rows (TSV)
admobctl finance range --from 2026-01 --to 2026-09

admobctl insights --last 30d --by ad-unit
```

Global flags:

| Flag | Meaning |
|---|---|
| `-o, --output json\|table\|csv\|markdown` | Default: `table` on a terminal, `json` when piped |
| `--profile <name>` | Use a named profile from the config |
| `--account pub-…` | Pick the publisher account (otherwise auto-selected when there is only one) |
| `-v, --verbose` | Debug logs to stderr |

Dates are `YYYY-MM` (whole month) or `YYYY-MM-DD`. Dimensions and metrics accept friendly names
(`app`, `ad-unit`, `country`, `format`, `platform`, `date`, `month`; `earnings`, `requests`, `impressions`,
`match-rate`, `show-rate`, `ctr`, `rpm`, `ecpm`).

All earnings are **estimates**. Reconcile them against AdMob Payments, because the API does not expose finalized earnings.

### Finance

`finance month` returns estimated earnings per app and the month total, with the per-app amounts rounded so they sum exactly to the total. It flags months that are not over yet. `--as journal` emits one debit row (receivable, default account 1509) and one credit row per app (revenue, default 3120), dated at month-end, with the columns `Bilag, Dato, Kilde, Beskrivelse, Konto, Kontonavn, Debet, Kredit, MVA-behandling, Motpart, Status, Merknad`. Set accounts, names, VAT text and the decimal separator with `admobctl config set finance.<key> <value>`.

### Insights

`insights` compares a period with the equally long period before it, by app, ad unit, country, format or platform. It reports earnings, share, eCPM, request RPM, match rate, show rate and CTR. Highlights cover top and bottom earners, high requests with low fill, low show rate, and swings above `--swing` percent, and a plain-language summary gives the numbers behind each claim.

## MCP server

`admobctl mcp` serves eight read-only tools over stdio: `admobctl_list_accounts`, `admobctl_list_apps`, `admobctl_list_ad_units`, `admobctl_network_report`, `admobctl_mediation_report`, `admobctl_finance_month`, `admobctl_finance_range` and `admobctl_insights`. Reports default to 200 rows and are trimmed with a notice to stay within roughly 25k tokens.

## Agent plugin (Claude Code and Codex)

This repo is also a plugin marketplace. The plugin bundles the MCP server and three skills:
`admobctl` (routing, auth, command reference), `admobctl-finance` (monthly bookkeeping, estimate vs finalized)
and `admobctl-insights` (how to analyze and present monetization findings). It needs only Node.js 20+ and
authentication (see above); `dist/admobctl.mjs` is committed, so no `npm install` is needed.

Claude Code:

```
/plugin marketplace add Strangees/admobctl
/plugin install admobctl@admobctl
```

Codex:

```bash
codex plugin marketplace add Strangees/admobctl
codex plugin add admobctl@admobctl
```

Then ask: *"What did my AdMob apps earn last month, per app?"*

### Plugin evals

`evals/` holds `claude plugin eval` cases that run against mocked MCP tools (`evals/mocks/`, generated from
synthetic fixtures with `npm run eval:mocks`), so no AdMob account is needed:

```bash
npm run eval -- --runs 3
```

## Configuration

`~/.admobctl/config.json` holds no secrets:

```bash
admobctl config set account pub-XXXXXXXXXXXXXXXX
admobctl config set quotaProject my-project
admobctl config set aliases.game ca-app-pub-XXXXXXXXXXXXXXXX~NNNNNNNNNN
admobctl config set finance.revenueAccount 3120
admobctl config get
```

## Development

Running admobctl needs Node.js 20+. Developing it (vitest) needs Node.js 22.12+.

```bash
npm test            # vitest
npm run typecheck
npm run build       # → dist/admobctl.mjs (single file, no runtime dependencies)
npm run check       # typecheck + bundle + tests
npm run eval        # plugin evals (uses your Claude credentials)

# Golden finance tests against your own account (stored in the gitignored test/fixtures/private/):
npm run record-fixtures -- --month 2026-09 --expect <booked total> --range 2026-01:2026-09 --expect-range <booked total>
```

See [.claude/CLAUDE.md](.claude/CLAUDE.md) for code conventions.

## License

MIT
