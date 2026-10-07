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

Run setup to sign in, choose the Google Cloud project used for API quota, and enable the APIs. It never prompts
for project, account, aliases or finance settings, even at a terminal: it prints the next command and available choices.

```bash
admobctl setup                      # shows what it would do; nothing changes without --yes
admobctl setup --yes                # do it (the Google sign-in opens your browser)
admobctl setup status               # every check, with the admobctl command that fixes each gap
```

Features decide which scopes and APIs setup asks for. `read` is always on:

| Feature | Adds | For |
|---|---|---|
| `read` | admob.readonly, cloud-platform; AdMob API | reports, finance, insights, MCP |
| `write` | admob.monetization | create apps/ad units/mappings, mediation changes |
| `payments` | adsense.readonly; AdSense Management API | `finance balance` |

```bash
admobctl setup --features write,payments --yes
```

Setup never drops a feature you already have. The steps also run on their own:
`setup login [--features …]`, `setup project list`, `setup project use <id>`, `setup apis [--features …] [--project <id>]`
(change commands are dry runs without `--yes`; `project list` is read-only). Sign-in, scope, quota-project and API errors
name the `admobctl setup …` command to run, and `auth doctor` is the same report as `setup status`. If
`GOOGLE_APPLICATION_CREDENTIALS` selects a service account, first unset it in the terminal running admobctl;
setup reports this manual prerequisite and refuses to open a login that would leave the override in place.
Account, aliases and finance settings use the existing `admobctl config set` commands below.

Sign-in uses gcloud **Application Default Credentials** (setup tells you how to install gcloud if it is missing). The
project and API steps call Google's APIs with your own user token, so they work even when gcloud's active account is a
service account. The AdMob API does **not** accept service accounts; you must sign in as a Google user with access to
the AdMob account.

**No gcloud?** Use your own OAuth client instead. In Google Cloud Console, create a *Desktop app* OAuth client in a
project with the AdMob API enabled, then:

```bash
admobctl auth login --client-id <id> --client-secret <secret> --cloud-platform [--write] [--payments]
```

The refresh token is stored in the macOS Keychain (on other OSes, a `0600` file in `~/.admobctl/`). `admobctl auth logout` revokes it.
After that, `admobctl setup login` uses this OAuth client and its saved secret, including `cloud-platform` for the
setup APIs. Browser sign-in requires a terminal in both modes. A quota project is optional for your own OAuth
client: without one, setup leaves API enablement to the client project and `setup status` probes actual API access.
To enable APIs in a specific project without changing your profile, use
`admobctl setup apis --project <client-project-id> --features payments --yes`. Google errors that name an API
consumer project include that project in the fix command, so the fix targets the failing consumer.

### Optional: unpaid balance (`finance balance`)

`finance balance` reads your current unpaid balance from the AdSense Management API, which serves the Google payments
account that AdMob pays out from. Turn it on with:

```bash
admobctl setup --features payments --yes
admobctl finance balance
```

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
admobctl finance forecast                             # this month so far + month-end projection
admobctl finance balance                              # current unpaid balance (optional setup below)
admobctl finance export --month 2026-09               # Revenue Journal JSON for accounting imports
admobctl finance export --from 2026-01 --to 2026-09 --as revenue-journal-csv

admobctl check                                        # exits 1 if earnings or fill dropped
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

Network and mediation reports take `--sort <field>[:asc|desc]` (any dimension or metric in the report) and `--compare previous`, which adds each row's value in the equal-length period just before and the change.

Reports, `insights` and `analyze consent|waterfall` take `--currency USD` (any ISO 4217 code) to convert earnings at
Google's daily average rate; the default is the account currency. Combinations the AdMob API rejects (two time
dimensions, `ad-type` with requests, match rate or RPM) fail before any API call, and default metrics that do not
fit the chosen dimensions are left out with a note. Reports also note when they include data that is still arriving
(today's AdMob data; the last day of third-party mediation data).

Dates are `YYYY-MM` (whole month) or `YYYY-MM-DD`. Dimensions and metrics accept friendly names
(`app`, `ad-unit`, `country`, `format`, `platform`, `date`, `month`; `earnings`, `requests`, `impressions`,
`match-rate`, `show-rate`, `ctr`, `rpm`, `ecpm`).

All earnings are **estimates**. Reconcile them against AdMob Payments, because the API does not expose finalized earnings. `finance balance` shows the current unpaid balance; payment history is not available from any API.

### Finance

`finance month` returns estimated earnings per app and the month total, with the per-app amounts rounded so they sum exactly to the total. It flags months that are not over yet. `--as journal` emits one debit row (receivable, default account 1509) and one credit row per app (revenue, default 3120), dated at month-end, with the columns `Bilag, Dato, Kilde, Beskrivelse, Konto, Kontonavn, Debet, Kredit, MVA-behandling, Motpart, Status, Merknad`. Set accounts, names, VAT text and the decimal separator with `admobctl config set finance.<key> <value>`.

`finance export` writes the same accruals in [Revenue Journal](spec/README.md), an open format for platform revenue bookkeeping: one balanced voucher per month, one revenue line per app. `--as revenue-journal-json` (default) or `revenue-journal-csv`; `--integer-amounts` writes JSON integers instead of decimal strings (`--scale 6` for micros); `--out <file>` writes a file only you can read. Lines carry account roles (`earnings_receivable`, `revenue`) and generic names; account numbers appear only when you have set `finance.receivableAccount` / `finance.revenueAccount`.

### Insights

`insights` compares a period with the equally long period before it, by app, ad unit, country, format or platform. It reports earnings, share, eCPM, request RPM, match rate, show rate and CTR. Highlights cover top and bottom earners, high requests with low fill, low show rate, and swings above `--swing` percent, and a plain-language summary gives the numbers behind each claim.

### Check

`admobctl check` is a health check for cron or a scheduled agent. It compares the last complete day with the seven days before it, per app and for all apps together, and exits 1 when daily earnings, match rate or show rate dropped by 30% or more:

```bash
admobctl check                                   # yesterday against the week before
admobctl check --window 3d --baseline 14d --drop 40
admobctl check || echo "AdMob dropped" | mail -s "AdMob check" you@example.com
```

An app that stops sending ad requests is a breach too. Apps with fewer than 1000 baseline requests are listed as `too little data` and not judged (`--min-requests`). Network data lands a few hours late, so run it from cron after about 04:00 in the account's time zone. Save your own defaults with `admobctl config set check.drop 40` (also `check.window`, `check.baseline`, `check.minRequests`).

### Lint

`admobctl lint` checks the setup rather than the numbers. It exits 1 on a problem: an app marked *action required*, or an enabled mediation group whose ad units are all gone or that has no enabled line. It also lists notes that are often intentional: apps still in review, groups that also target an ad unit that is gone, ad units with no ad requests in the last 30 days, and ad units in no enabled mediation group. Mediation groups need AdMob API v1beta; without access those checks are skipped with a notice.

### Analyze

- `analyze versions --by sdk|app|os` shows match rate, show rate and CTR per Google Mobile Ads SDK version (grouped by platform), app version (grouped by app; `--app` narrows it) or OS version, and flags versions that fill or show at least 20% worse than the rest of their group. Versions with fewer than 1,000 requests are marked as thin data and not judged. It uses traffic metrics only, because Google documents the version dimensions as incompatible with earnings.
- `analyze consent` breaks traffic and earnings down per app and serving restriction (non-personalized, limited ads, RDP…) and compares each restricted mode's eCPM with the same app's unrestricted traffic, because apps differ too much in eCPM for an account-wide comparison to mean anything. Rows with too little traffic on either side are marked as thin data. The data starts 2021-03-13.
- `analyze waterfall` lists each mediation group's lines (ad source instances) by observed eCPM, with their share of the group's earnings, and flags idle lines (requests, no impressions) and lines that rarely fill.
- `analyze geo` breaks earnings, fill and eCPM down per country and ad format, with each cell's eCPM relative to its format across all countries. It flags a country that brings half or more of the earnings, big cells that fill far worse than the same format elsewhere, and small cells that pay 1.5× their format's average or more. Cells with fewer than 1,000 requests (`--min-requests`) are marked as thin data.
- `analyze trend` turns earnings into a daily series to answer "when did it change?". It reports the day daily earnings moved to a new level (when one split explains at least half of the variation with a change of 20% or more), the average per weekday, and the first day with traffic, so days before an app went live do not pull its averages down. `--by app|format|country|platform` gives one series each (the ten biggest); `--app` narrows it.

`apps list` shows each app's approval state, and `auth doctor` warns about apps marked *action required* in AdMob.

`apps app-ads` checks each app's app-ads.txt the way AdMob's crawler does, because a missing or broken file quietly limits ad serving. It reads the developer website from the App Store listing's marketing URL, fetches `/app-ads.txt` from that host (without `www.`/`m.`, https then http), and looks for `google.com, pub-…, DIRECT, f08c47fec0942fa0`. Google Play listings cannot be read, so Android apps need a website from config: `admobctl config set websites.<alias> <url>` per app, or `admobctl config set website <url>` for all of them. `--website <url>` overrides both for one run. It reports a status per app, prints the exact line to add, and exits 1 when an app has a problem.

### Mediation setup and campaigns (AdMob API v1beta)

```bash
admobctl ad-sources list                             # ad networks available for mediation
admobctl ad-sources adapters "Example Bidder"         # adapters per platform/format and the settings a mapping needs
admobctl mediation-groups list --format banner        # targeting, lines and A/B experiment state
admobctl mediation-groups show "Banners"              # one group's lines: ad source, CPM mode, manual CPM (USD)
admobctl mediation-groups export "Banners" --out banners.json   # the group as JSON for `mediation-groups create --file`
admobctl ad-units mappings "Quiz banner"              # third-party mappings of an ad unit
admobctl report campaign --from 2026-07 --to 2026-09 --by campaign   # app-promotion campaigns: installs, cost, CPI
```

These read-only commands use the AdMob API's v1beta surface with the same `admob.readonly` scope. Google limits some
v1beta methods (mediation groups and ad unit mappings in particular) to allowlisted accounts; when access is denied the
error says so and points to your AdMob account manager, and `auth doctor` shows which v1beta reads your account can
use. Campaign reports take at most 30 days per request, so longer ranges are fetched in 30-day chunks and added up.

`mediation-groups export` is for backup and cloning: it prints a group (or, without a name, every group as an array) as the JSON `mediation-groups create --file` takes, without IDs and output-only fields. The AdMob Network line is left out because a new group gets its own (`--with-admob-line` keeps it; `create` then warns that AdMob may reject or duplicate it), and so are the treatment lines of a running A/B experiment.

### Changing AdMob (write commands)

admobctl can also create apps, ad units and ad unit mappings, and change mediation groups and A/B experiments. These
calls use the AdMob API's v1beta write methods, which need two things beyond the read-only setup:

1. **The `write` feature** (the `admob.monetization` scope): `admobctl setup --features write --yes`
   (or `admobctl auth login --write` with your own OAuth client). `setup status` says when write commands are enabled.
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

`admobctl mcp` serves read-only tools over stdio: `admobctl_list_accounts`, `admobctl_list_apps`, `admobctl_list_ad_units`, `admobctl_network_report`, `admobctl_mediation_report`, `admobctl_finance_month`, `admobctl_finance_range`, `admobctl_finance_export`, `admobctl_finance_forecast`, `admobctl_finance_balance`, `admobctl_setup_status`, `admobctl_insights`, `admobctl_check`, `admobctl_lint`, `admobctl_analyze_versions`, `admobctl_analyze_consent`, `admobctl_analyze_waterfall`, `admobctl_analyze_geo`, `admobctl_analyze_trend`, `admobctl_campaign_report`, `admobctl_list_ad_sources`, `admobctl_list_adapters`, `admobctl_list_mediation_groups`, `admobctl_list_ad_unit_mappings` and `admobctl_check_app_ads`. Reports default to 200 rows and are trimmed with a notice to stay within roughly 25k tokens.

## Agent plugin (Claude Code and Codex)

This repo is also a plugin marketplace. The plugin, in [`plugin/`](plugin/README.md), bundles the MCP server and three
skills: `admobctl` (routing, auth, command reference), `admobctl-finance` (monthly bookkeeping, estimate vs finalized)
and `admobctl-insights` (how to analyze and present monetization findings). It needs only Node.js 20+ and
authentication (see above): `plugin/dist/admobctl.mjs` is committed and the plugin folder has no `package.json`, so
installing the plugin downloads no packages.

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

`plugin/evals/` holds `claude plugin eval` cases that run against mocked MCP tools (`plugin/evals/mocks/`, generated
from synthetic fixtures with `npm run eval:mocks`), so no AdMob account is needed:

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

## Data and privacy

admobctl runs on your computer. It has no server of its own and no telemetry, and it sends nothing to its author or
any other third party. It talks only to Google's APIs, with your own credentials, and for the app-ads.txt check to
Apple's App Store lookup and your apps' websites. The [plugin README](plugin/README.md#data-and-privacy) lists every
host, program and file it uses, and [PRIVACY.md](PRIVACY.md) is the full policy.

## Development

Running admobctl needs Node.js 20+. Developing it (vitest) needs Node.js 22.12+.

```bash
npm test            # vitest
npm run typecheck
npm run build       # → plugin/dist/admobctl.mjs (single file, no runtime dependencies)
npm run check       # typecheck + bundle + tests
npm run eval        # plugin evals (uses your Claude credentials)

# Golden finance tests against your own account (stored in the gitignored test/fixtures/private/):
npm run record-fixtures -- --month 2026-09 --expect <booked total> --range 2026-01:2026-09 --expect-range <booked total>
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for code conventions and what a pull request needs. Report security problems
privately as described in [SECURITY.md](SECURITY.md).

### CI and releases

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs on every pull request and push to `main`: typecheck,
tests, and checks that the committed bundle and eval mocks match the source. The tests also guard that the version is
the same everywhere and that no real publisher IDs or email addresses are committed.

Plugins install straight from `main`, and `claude plugin update` only notices a new version number. To release, bump
the version and merge to `main`:

```bash
npm version <patch|minor|major> --no-git-tag-version   # package.json + lockfile
# set the same version in plugin/.claude-plugin/plugin.json and plugin/.codex-plugin/plugin.json
npm run check                                          # rebuilds the bundle with the new version
npm run eval:mocks                                     # the admobctl_finance_export mock embeds the version
```

Commit the bundle and `plugin/evals/mocks/` with the version bump; CI fails when either is stale.

When CI passes on `main`, it tags `v<version>` and publishes a GitHub release with the bundle and its checksum.
A push that does not change the version releases nothing.

Dependabot ([.github/dependabot.yml](.github/dependabot.yml)) opens weekly grouped updates. The `dev-tools` group
(TypeScript, vitest, `@types/node`) passes CI as it is. The `bundled` group holds esbuild and the packages it builds
into the bundle (commander, zod, the MCP SDK, ajv). Dependabot does not rebuild the bundle, so when it changes, CI
fails "Committed bundle is up to date" until you finish the pull request:

```bash
gh pr checkout <number>
npm ci && npm run check                       # rebuilds plugin/dist/admobctl.mjs
npm run eval:mocks                            # in case the tool schemas changed
git add plugin/dist plugin/evals/mocks && git commit -m "Rebuild the bundle" && git push
```

The new packages reach users only with a release, so bump the version as well when they should get them (a security
fix, say).

## License

MIT, except the Revenue Journal specification text in [spec/](spec/), which is CC BY 4.0; the spec's schema, examples
and conformance files are MIT too ([spec/LICENSE](spec/LICENSE)).
