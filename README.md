# admobctl

A fast command-line tool for the Google AdMob API, with an agent plugin for Claude Code and Codex.

> **Unofficial.** admobctl is not affiliated with, endorsed by, or sponsored by Google. "AdMob" is a trademark of Google LLC.

- Human-friendly app aliases (`my-game-ios`) instead of resource IDs
- Network and mediation reports as table, JSON, CSV or Markdown
- Monthly finance output you can book directly (per app, journal rows)
- Monetization insights: eCPM/RPM, fill and show rate, weakest units, swings vs the previous period
- Curated analyses: SDK/app/OS version health, consent (serving restriction) impact, mediation waterfall
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
admobctl finance export --month 2026-09               # Revenue Journal JSON for accounting imports
admobctl finance export --from 2026-01 --to 2026-09 --as revenue-journal-csv

admobctl insights --last 30d --by ad-unit

admobctl analyze versions --by sdk                  # match/show rate per SDK version, per platform
admobctl analyze versions --by app --app my-game-ios
admobctl analyze consent --last 30d                  # per app: eCPM under consent/RDP/limited ads vs unrestricted
admobctl analyze waterfall --group "Banners"         # mediation lines by observed eCPM
```

Global flags:

| Flag | Meaning |
|---|---|
| `-o, --output json\|table\|csv\|markdown` | Default: `table` on a terminal, `json` when piped |
| `--profile <name>` | Use a named profile from the config |
| `--account pub-…` | Pick the publisher account (otherwise auto-selected when there is only one) |
| `-v, --verbose` | Debug logs to stderr |

Reports, `insights` and `analyze consent|waterfall` take `--currency USD` (any ISO 4217 code) to convert earnings at
Google's daily average rate; the default is the account currency. Combinations the AdMob API rejects (two time
dimensions, `ad-type` with requests, match rate or RPM) fail before any API call, and default metrics that do not
fit the chosen dimensions are left out with a note. Reports also note when they include data that is still arriving
(today's AdMob data; the last day of third-party mediation data).

Dates are `YYYY-MM` (whole month) or `YYYY-MM-DD`. Dimensions and metrics accept friendly names
(`app`, `ad-unit`, `country`, `format`, `platform`, `date`, `month`; `earnings`, `requests`, `impressions`,
`match-rate`, `show-rate`, `ctr`, `rpm`, `ecpm`).

All earnings are **estimates**. Reconcile them against AdMob Payments, because the API does not expose finalized earnings.

### Finance

`finance month` returns estimated earnings per app and the month total, with the per-app amounts rounded so they sum exactly to the total. It flags months that are not over yet. `--as journal` emits one debit row (receivable, default account 1509) and one credit row per app (revenue, default 3120), dated at month-end, with the columns `Bilag, Dato, Kilde, Beskrivelse, Konto, Kontonavn, Debet, Kredit, MVA-behandling, Motpart, Status, Merknad`. Set accounts, names, VAT text and the decimal separator with `admobctl config set finance.<key> <value>`.

`finance export` writes the same accruals in [Revenue Journal](spec/README.md), an open format for platform revenue bookkeeping: one balanced voucher per month, one revenue line per app. `--as revenue-journal-json` (default) or `revenue-journal-csv`; `--integer-amounts` writes JSON integers instead of decimal strings (`--scale 6` for micros); `--out <file>` writes a file only you can read. Lines carry account roles (`earnings_receivable`, `revenue`) and generic names; account numbers appear only when you have set `finance.receivableAccount` / `finance.revenueAccount`.

### Insights

`insights` compares a period with the equally long period before it, by app, ad unit, country, format or platform. It reports earnings, share, eCPM, request RPM, match rate, show rate and CTR. Highlights cover top and bottom earners, high requests with low fill, low show rate, and swings above `--swing` percent, and a plain-language summary gives the numbers behind each claim.

### Analyze

- `analyze versions --by sdk|app|os` shows match rate, show rate and CTR per Google Mobile Ads SDK version (grouped by platform), app version (grouped by app; `--app` narrows it) or OS version, and flags versions that fill or show at least 20% worse than the rest of their group. Versions with fewer than 1,000 requests are marked as thin data and not judged. It uses traffic metrics only, because Google documents the version dimensions as incompatible with earnings.
- `analyze consent` breaks traffic and earnings down per app and serving restriction (non-personalized, limited ads, RDP…) and compares each restricted mode's eCPM with the same app's unrestricted traffic, because apps differ too much in eCPM for an account-wide comparison to mean anything. Rows with too little traffic on either side are marked as thin data. The data starts 2021-03-13.
- `analyze waterfall` lists each mediation group's lines (ad source instances) by observed eCPM, with their share of the group's earnings, and flags idle lines (requests, no impressions) and lines that rarely fill.

`apps list` shows each app's approval state, and `auth doctor` warns about apps marked *action required* in AdMob.

`apps app-ads` checks each app's app-ads.txt the way AdMob's crawler does, because a missing or broken file quietly limits ad serving. It reads the developer website from the App Store listing's marketing URL, fetches `/app-ads.txt` from that host (without `www.`/`m.`, https then http), and looks for `google.com, pub-…, DIRECT, f08c47fec0942fa0`. Google Play listings cannot be read, so Android apps need a website from config: `admobctl config set websites.<alias> <url>` per app, or `admobctl config set website <url>` for all of them. `--website <url>` overrides both for one run. It reports a status per app, prints the exact line to add, and exits 1 when an app has a problem.

### Mediation setup and campaigns (AdMob API v1beta)

```bash
admobctl ad-sources list                             # ad networks available for mediation
admobctl ad-sources adapters "Example Bidder"         # adapters per platform/format and the settings a mapping needs
admobctl mediation-groups list --format banner        # targeting, lines and A/B experiment state
admobctl mediation-groups show "Banners"              # one group's lines: ad source, CPM mode, manual CPM (USD)
admobctl ad-units mappings "Quiz banner"              # third-party mappings of an ad unit
admobctl report campaign --from 2026-07 --to 2026-09 --by campaign   # app-promotion campaigns: installs, cost, CPI
```

These read-only commands use the AdMob API's v1beta surface with the same `admob.readonly` scope. Google limits some
v1beta methods (mediation groups and ad unit mappings in particular) to allowlisted accounts; when access is denied the
error says so and points to your AdMob account manager, and `auth doctor` shows which v1beta reads your account can
use. Campaign reports take at most 30 days per request, so longer ranges are fetched in 30-day chunks and added up.

### Changing AdMob (write commands)

admobctl can also create apps, ad units and ad unit mappings, and change mediation groups and A/B experiments. These
calls use the AdMob API's v1beta write methods, which need two things beyond the read-only setup:

1. **The `admob.monetization` scope.** Sign in again with it:
   `gcloud auth application-default login --scopes=https://www.googleapis.com/auth/admob.readonly,https://www.googleapis.com/auth/admob.monetization,https://www.googleapis.com/auth/cloud-platform`
   (or `admobctl auth login --write`). `auth doctor` says when write commands are enabled.
2. **Allowlisting by Google.** Google marks these methods as limited access. Without it they return 403, and
   admobctl tells you to contact your AdMob account manager.

Every write command is a **dry run unless you add `--yes`**: it prints the exact request (method, URL, update mask and
JSON body) and a plain-words summary, then exits without sending anything. Input is checked first: formats and ad
types, adapter platform and format, required adapter settings, CPMs, experiment state. Applied writes, including
failed ones, are appended to `~/.admobctl/audit.log`; `admobctl audit-log` shows them, newest first.

```bash
admobctl apps create --platform android --store-id com.example.game
admobctl ad-units create --app my-game-android --name "Level end" --format rewarded --reward 10:coins
admobctl ad-units map "Level end" --ad-source "Example Bidder" --adapter "Example Bidder (Android)" --set "Placement ID=abc"
admobctl ad-units map-batch --file mappings.json        # [{adUnit, adSource, adapter, name?, settings}], 100 per request
admobctl mediation-groups create --file group.json       # MediationGroup JSON, new lines keyed "-1", "-2"…
admobctl mediation-groups set-line "Banners" "Waterfall 3.00" --cpm 2.50          # manual CPMs are USD
admobctl mediation-groups set-line "Banners" "Waterfall 3.00" --state disabled
admobctl mediation-groups add-line "Banners" --ad-source "Example Waterfall" --name "Waterfall 5.00" --cpm 5 \
  --mapping "Quiz banner=accounts/pub-…/adUnits/…/adUnitMappings/…"
admobctl mediation-groups set-ad-units "Banners" "Quiz banner" "Quiz banner (Android)"
admobctl mediation-groups experiment start "Banners" --name "Floor test" --percent 50 --lines treatment.json
admobctl mediation-groups experiment stop "Banners" --keep B
# …then repeat the command with --yes to apply it.
```

The MCP server stays read-only: no write is exposed as an MCP tool.

## MCP server

`admobctl mcp` serves read-only tools over stdio: `admobctl_list_accounts`, `admobctl_list_apps`, `admobctl_list_ad_units`, `admobctl_network_report`, `admobctl_mediation_report`, `admobctl_finance_month`, `admobctl_finance_range`, `admobctl_finance_export`, `admobctl_insights`, `admobctl_analyze_versions`, `admobctl_analyze_consent`, `admobctl_analyze_waterfall`, `admobctl_campaign_report`, `admobctl_list_ad_sources`, `admobctl_list_adapters`, `admobctl_list_mediation_groups`, `admobctl_list_ad_unit_mappings` and `admobctl_check_app_ads`. Reports default to 200 rows and are trimmed with a notice to stay within roughly 25k tokens.

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
admobctl config set websites.game-android example.com   # developer website for the app-ads.txt check (Android)
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

### CI and releases

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs on every pull request and push to `main`: typecheck,
tests, and checks that the committed bundle and eval mocks match the source. The tests also guard that the version is
the same everywhere and that no real publisher IDs or email addresses are committed.

Plugins install straight from `main`, and `claude plugin update` only notices a new version number. To release, bump
the version and merge to `main`:

```bash
npm version <patch|minor|major> --no-git-tag-version   # package.json + lockfile
# set the same version in .claude-plugin/plugin.json and .codex-plugin/plugin.json
npm run check                                          # rebuilds the bundle with the new version
```

When CI passes on `main`, it tags `v<version>` and publishes a GitHub release with the bundle and its checksum.
A push that does not change the version releases nothing.

## License

MIT
