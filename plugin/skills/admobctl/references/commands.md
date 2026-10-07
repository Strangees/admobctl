# admobctl command reference

Global flags (any command): `-o json|table|csv|markdown` (default: table on a TTY, json when piped),
`--profile <name>`, `--account pub-…`, `-v` (debug logs to stderr). Run `admobctl <cmd> --help` for details.

## Setup and auth

| Command | Purpose |
|---|---|
| `admobctl setup [--features write,payments] [--project <id>] [--yes]` | Guided: sign-in → quota project → APIs. Dry run without `--yes`; stops with `Next: <command>` when it needs the user. Never prompts. |
| `admobctl setup status` (= `auth doctor`) | Checks credentials → token → scope → features → quota project → APIs → AdMob API → account → apps → beta. Each gap has `fix_command`; JSON has `next_command`. Exit 1 on a failure. |
| `admobctl setup login [--features …] [--yes]` | Sign in with the scopes the features need (both gcloud and own OAuth client open the browser; must run in a terminal). Keeps scopes already granted. |
| `admobctl setup project list` / `setup project use <id> [--yes]` | Google Cloud projects you can use / store one as the quota project. |
| `admobctl setup apis [--features …] [--project <id>] [--yes]` | Enable APIs in the explicit project or the quota project (as your user). `--project` does not overwrite the profile. OAuth without a quota project leaves enablement to its client project; `setup status` probes access. |
| `admobctl auth status` | Active mode (adc/oauth), quota project, scopes, account |
| `admobctl auth login --client-id <id> --client-secret <s> [--write] [--payments] [--cloud-platform]` | Own Desktop OAuth client; refresh token goes to the macOS Keychain. Switches the profile to `oauth`. `--write` also grants admob.monetization; `--payments` grants adsense.readonly (for `finance balance`); `--cloud-platform` grants Cloud project/API management access. `setup login` requests it automatically and reuses the saved client secret. |
| `admobctl auth logout` | Revoke and forget the OAuth login; back to gcloud ADC |

First-time setup (gcloud ADC, the default): `admobctl setup --yes` in the user's terminal, then `admobctl setup status`.

Service accounts are not supported by the AdMob API.

## Inventory

| Command | Output |
|---|---|
| `admobctl accounts list` | publisherId, currencyCode, reportingTimeZone |
| `admobctl apps list` | alias, name, platform, appId, storeId, approval (JSON: APPROVED, IN_REVIEW, ACTION_REQUIRED) |
| `admobctl ad-units list [--app <alias>]` | app alias, name, format, adUnitId |
| `admobctl apps app-ads [--app <alias>] [--website <url>]` | per app: status (ok, missing-file, html, no-line, reseller-only, unreachable, no-website, unknown-website, not-linked), website and its source (store, flag, config), checked URLs, detail; plus expectedLine. Exits 1 on a problem. |

v1beta (read-only, `admob.readonly`; Google may require allowlisting, a 403 says so):

| Command | Output |
|---|---|
| `admobctl ad-units mappings <ad-unit>` | id, name, adapterId, state, settings (adapter setting ID → value) |
| `admobctl ad-sources list` | title, adSourceId |
| `admobctl ad-sources adapters <ad-source>` | adapter title, adapterId, platform, formats, settings (id, label, required) |
| `admobctl mediation-groups list [--app] [--ad-source] [--format] [--platform] [--state]` | name, id, state, platform, format, adUnits, regions, experiment (running/none), lines |
| `admobctl mediation-groups export [group] [--name <n>] [--with-admob-line] [--out <file>]` | the group as MediationGroup JSON for `mediation-groups create --file` (all groups: a JSON array); always JSON |
| `admobctl mediation-groups show <group>` | the group's lines: name, adSource, cpmMode, cpm (USD, manual lines only), state, variant (A/B) |

Apps take an alias (`<name>-<platform>`, e.g. `my-game-ios`), app ID, numeric ID or exact name.
Custom alias: `admobctl config set aliases.<alias> <appId>`.

app-ads.txt: iOS websites come from the App Store listing's marketing URL. Google Play listings cannot be read, so Android
apps use `--website` (this run), then `admobctl config set websites.<alias> <url>` (per app), then `admobctl config set website <url>`
(all apps); without one they show `unknown-website`. Ask the user for the website instead of guessing it.

`mediation-groups export` drops IDs and output-only fields, keys the lines "-1", "-2"…, and leaves out the AdMob Network
line (a new group gets its own; `--with-admob-line` keeps it, and the `create` dry run then warns that AdMob may reject
or duplicate it) and the treatment lines of a running A/B experiment. It
reads only. To clone a group to other ad units, edit `displayName`, `targeting.adUnitIds` and each line's
`adUnitMappings` in the file, then run `mediation-groups create --file <file>` (a dry run without `--yes`).

## Reports

```bash
admobctl report network   --from YYYY-MM[-DD] [--to …] [--by dims] [--metrics m] [--filter k=v,v] [--max-rows n]
                          [--sort field[:asc|desc]] [--compare previous]
admobctl report mediation --from … [--to …] --by ad-source,app
```

- `--from 2026-09` alone = the whole month. `--by` defaults to `app`.
- Network dimensions: date, month, week, app, ad-unit, ad-type, country, format, platform,
  mobile-os-version, gma-sdk-version, app-version-name, serving-restriction.
- Mediation adds: ad-source, ad-source-instance, mediation-group.
- Metrics: earnings, requests, matched-requests, impressions, clicks, match-rate, show-rate, ctr,
  rpm (network), ecpm (mediation).
- `--filter app=<alias>` resolves aliases; `--filter country=NO,SE` (ISO codes); repeatable.
- JSON `dimensions` and `metrics` list the row keys (e.g. `["app"]`, `["earnings","requests",…,"rpm"]`).
- JSON rows carry money as a rounded amount (`earnings`) plus exact `earnings_micros`. Rates are fractions (0.75 = 75%).
- `totals` is omitted when the report is truncated (`truncated: true`).
- `--sort impressions`, `--sort match-rate:asc`, `--sort country`: any dimension or metric of the report (dimensions
  ascend, metrics descend by default). Without it: by time for a time series, else by earnings.
- `--compare previous` adds, per row and in `totals`, `previous_<metric>` and `<metric>_change` (a fraction, 0.5 = +50%)
  against the equal-length period just before (`previous.from`/`to`). A row without `previous_*` keys is new; rows that
  existed only before are counted in `notices` (not when the report is truncated). Changes in money totals are computed
  from micros (`rpm_micros`, `ecpm_micros`…), not from rounded amounts. Not with date, week or month. The table shows the first metric's change.
- `--currency USD` converts earnings (Google's daily average rate); the API then adds a warning that converted
  earnings may not match the payment.
- Only one of date/week/month per report; `ad-type` cannot be combined with requests, match-rate or rpm. Default
  metrics that do not fit the dimensions are left out and listed in `notices`.
- `notices` also flags data still arriving: today (AdMob, ~4h delay) and, for mediation, the last day (third-party
  sources lag 8-24h). `warnings` are the API's own (e.g. DATA_DELAYED).

### Campaign report (v1beta)

```bash
admobctl report campaign --from YYYY-MM[-DD] [--to …] [--by campaign,country] [--metrics installs,cost,cpi]
```

- AdMob app-promotion campaigns, where the user is the advertiser. Dimensions: campaign (name), campaign-id, ad,
  ad-id, placement, placement-id, placement-platform, country, format, date. Metrics: impressions, clicks, ctr,
  installs, cost, cpi, interactions.
- At most 30 days per API request: longer ranges are fetched in chunks and added up (CTR and CPI recomputed).
- Cost and CPI are in the campaigns' reporting currency (`cost_micros`, `cpi` in JSON).

## Finance

```bash
admobctl finance month YYYY-MM [--as summary|journal|csv|json]
admobctl finance range --from YYYY-MM --to YYYY-MM [--as …]
admobctl finance forecast [YYYY-MM]                    # month to date + month-end projection (default: this month)
admobctl finance balance [--as summary|csv|json]       # current unpaid balance (AdSense Management API)
admobctl finance export (--month YYYY-MM | --from YYYY-MM --to YYYY-MM) [--as revenue-journal-json|revenue-journal-csv]
                        [--integer-amounts [--scale 0-6]] [--out file]   # Revenue Journal (spec/SPEC.md)
```

- Per-app amounts are rounded so they sum exactly to the total.
- `complete: false` means the month has not ended (account time zone).
- `forecast`: per app `month_to_date` and `projected` (the daily average of the month's complete days carried to
  month-end), plus `days_elapsed`, `days_in_month`, `daily_average`. `projection: false` for a month that has ended.
  Pacing only, never a booking figure. Takes `--as summary|csv|json`.
- `balance`: `account`, `currency`, `unpaid` (+ `unpaidMicros`) from the AdSense Management API; it includes AdMob
  earnings. Not a monthly figure, and no payment history (the API leaves out AdMob payouts). Needs the
  adsense.readonly scope and `adsense.googleapis.com` enabled in the quota project; errors carry the exact fix.
- `--as journal` prints tab-separated Bilagsjournal rows (Bilag, Dato, Kilde, Beskrivelse, Konto, Kontonavn,
  Debet, Kredit, MVA-behandling, Motpart, Status, Merknad), dated at month-end: debit the receivable (default 1509),
  credit revenue (default 3120) per app.
- Finance config: `admobctl config set finance.<key> <value>`, where key is one of receivableAccount, revenueAccount,
  receivableAccountName, revenueAccountName, vatTreatment, counterparty, decimalSeparator (`.` or `,`).

## Insights

```bash
admobctl insights [--last 30d | --from … --to …] [--by ad-unit|app|country|format|platform] [--swing 30] [--currency X]
```

Returns rows (earnings, share, change vs the previous equal-length period, eCPM, request RPM, match rate, show rate, CTR),
highlights (top, bottom, low-fill, low-show-rate, swing-up, swing-down, new, gone) and a plain-language summary.

## Check

```bash
admobctl check [--window 1d] [--baseline 7d] [--drop 30] [--min-requests 1000] [--app <alias>]
```

A health check for cron or a scheduled agent. Compares the window (complete days ending yesterday) with the baseline
(the days just before it), per app and for all apps together: daily earnings, match rate and show rate. The window ends
yesterday in the account's time zone and network data lands a few hours late, so schedule it after about 04:00 there.

- A drop of `--drop` percent or more is a breach: listed in `findings` (app, metric, change, message), counted in
  `breaches`, and the command **exits 1**. No breach: exit 0.
- Row `status`: `ok`, `breach`, or `thin` (fewer than `--min-requests` baseline requests: not judged). Rates also need
  a tenth of that many in the window: requests for match rate, matched requests for show rate.
- An app with enough baseline requests but none in the window is a breach ("sent no ad requests"): metric `earnings`
  when the baseline earned something, else `requests`.
- Defaults can be saved: `admobctl config set check.<key> <n>` with key window, baseline, drop or minRequests.

## Lint

```bash
admobctl lint [--app <alias>] [--last 30d | --from … --to …]
```

Checks the setup by joining apps, ad units and mediation groups with traffic. `findings` have `kind`, `severity`,
`target`, `app` and `message`; `problems` counts the problems, and the command **exits 1** when there is one.

| Kind | Severity | Meaning |
|---|---|---|
| `app-action-required` | problem | The app needs the publisher's attention in AdMob review |
| `missing-ad-unit` | problem / note | An enabled mediation group targets an ad unit that is not in the account: a problem when none of its ad units exist, a note when the others still serve |
| `no-enabled-lines` | problem | An enabled mediation group has no enabled line |
| `app-in-review` | note | The app is still in AdMob review |
| `unused-ad-unit` | note | The ad unit sent no ad requests in the period |
| `ungrouped-ad-unit` | note | The ad unit is in no enabled mediation group (only reported when the account has groups) |

Mediation checks need AdMob API v1beta; without access they are skipped with a notice and `checked.mediation_groups`
is null.

## Analyze

```bash
admobctl analyze versions  [--by sdk|app|os] [--app <alias>] [--last 30d | --from … --to …]
admobctl analyze consent   [--app <alias>] [--currency X] [--last 30d | --from … --to …]
admobctl analyze waterfall [--app <alias>] [--group <name|id>] [--currency X] [--last 30d | --from … --to …]
admobctl analyze geo       [--app <alias>] [--min-requests 1000] [--currency X] [--last 30d | --from … --to …]
admobctl analyze trend     [--by total|app|format|country|platform] [--app <alias>] [--currency X] [--last 30d | --from … --to …]
```

- `versions`: requests, share of the group (platform, or app for app versions), match rate, show rate, CTR per
  version. Highlights `low-match-rate` / `low-show-rate` when a version with ≥5% of its group's traffic does ≥20%
  worse than the group's other versions. No earnings (the API does not split earnings by version).
- `consent`: per serving restriction: requests and share, earnings, eCPM, `ecpm_vs_unrestricted`, match and show
  rate; `restricted_request_share` overall. Data from 2021-03-13.
- `waterfall`: `groups` (earnings per mediation group) and `rows` (one per ad source instance: observed `ecpm`,
  earnings and `earnings_share` of the group, requests, match rate, impressions), sorted by group earnings then eCPM.
  Highlights `top` (per group), `idle` (requests but no impressions), `low-fill` (<2% match rate on ≥5% of the group's requests).

- `geo`: `rows` (one per country and format: earnings and `earnings_share`, requests and `format_request_share`,
  match rate, show rate, `ecpm`, `ecpm_vs_format`, `enough_data`) and `countries` (totals per country; the MCP tool
  returns the 25 biggest and says so in `notices`). Highlights:
  `concentration` (one country ≥ 50% of earnings), `low-fill` (≥ 5% of a format's requests, match rate under 70% of
  that format elsewhere), `high-ecpm` (eCPM ≥ 1.5× the format's average on < 5% of its requests).
- `trend`: one series (the account, or `--app`) or one per `--by` value (the ten biggest). Per series: `earnings`,
  `average_per_day`, `first_active` (first day with traffic; earlier days are left out of the averages, later days
  without traffic count as zero), `weekdays` (average per weekday) and `days` (date, weekday, earnings, requests,
  match rate, show rate, eCPM). `shift` is set when daily earnings moved to a new level: `date`, `before_per_day`,
  `after_per_day`, `change`. Highlights: `shift-up`, `shift-down`, `weekday` (best weekday ≥ 1.3× the worst),
  `started`. The table shows the days for one series and one line per series otherwise.

## MCP tools (`admobctl mcp`)

admobctl_list_accounts, admobctl_list_apps, admobctl_list_ad_units, admobctl_network_report,
admobctl_mediation_report, admobctl_finance_month, admobctl_finance_range, admobctl_finance_export, admobctl_finance_forecast, admobctl_finance_balance, admobctl_setup_status,
admobctl_insights, admobctl_check, admobctl_lint,
admobctl_analyze_versions, admobctl_analyze_consent, admobctl_analyze_waterfall, admobctl_analyze_geo, admobctl_analyze_trend (`include_days` for the daily rows), admobctl_campaign_report,
admobctl_list_ad_sources, admobctl_list_adapters (`ad_source`), admobctl_list_mediation_groups,
admobctl_list_ad_unit_mappings (`ad_unit`), admobctl_check_app_ads.
Most arguments are the CLI's options in snake_case (`max_rows`, `sort`, `compare`, `currency`, `min_requests`, `app`,
`account`). The exceptions:
- `--last 30d` is `last_days: 30`.
- Report filters are one `filters` object, e.g. `{"country": ["NO","SE"], "app": ["my-game-ios"]}`, not `--filter`.
- `admobctl_finance_month` returns journal rows with `include_journal: true` (not `--as journal`);
  `admobctl_finance_range` has no journal option.
- `admobctl_insights` has no `swing` (a 30% change counts as a swing).
- `admobctl_check` takes `window_days`, `baseline_days`, `drop_percent`, `min_requests`, `app`.
- `admobctl_finance_export` takes `month` or `from`+`to`, `as` (`json` or `csv`), `integer_amounts`, `scale`, and returns
  the file as `content` (no `--out`).
- No `-o` and, apart from `admobctl_finance_export`'s `as`, no `--as`: tools return JSON. The profile is the one
  `admobctl mcp` started with.
Reports default to 200 rows.

## Write commands (v1beta; CLI only)

Need the `write` feature (`admobctl setup --features write --yes`) and Google allowlisting (403 → contact the AdMob account manager).
**Without `--yes` every write is a dry run**: it prints the request and a summary (JSON: `{applied: false, plans}`).
With `--yes` it applies them in order (JSON: `{applied: true, plans, results}`) and appends each to `~/.admobctl/audit.log`.

| Command | Does |
|---|---|
| `apps create --platform ios\|android (--name <n> \| --store-id <id>)` | Create an app (manual or store-linked) |
| `ad-units create --app <a> --name <n> --format <f> [--ad-types rich-media,video] [--reward 10:coins]` | Create an ad unit; formats: app-open, banner, interstitial, native, rewarded, rewarded-interstitial |
| `ad-units map <ad-unit> --ad-source <s> --adapter <a> [--name] --set "Label=value"…` | Create an ad unit mapping; settings by label or ID, required ones checked |
| `ad-units map-batch --file <json>` | Many mappings, 100 per request (each request all-or-nothing) |
| `mediation-groups create --file <json>` | Create a group from MediationGroup JSON (new lines keyed "-1", "-2"…) |
| `mediation-groups set-line <group> <line> [--cpm <usd>] [--state enabled\|disabled] [--name]` | Update one line (CPM only on MANUAL lines; USD) |
| `mediation-groups add-line <group> --ad-source <s> --name <n> [--cpm <usd>] [--mapping <ad-unit>=<mapping>]…` | Add a line (LIVE without --cpm) |
| `mediation-groups set-ad-units <group> <ad-unit>…` | Replace the group's targeted ad units |
| `mediation-groups experiment start <group> --name <n> --percent <1-99> --lines <json>` | Start an A/B experiment with treatment lines |
| `mediation-groups experiment stop <group> --keep A\|B` | Stop it, keeping the original (A) or treatment (B) lines |

`admobctl audit-log [--last <n>] [--failed]` reads that log back, newest first: time, action, request, outcome
(the created resource, or `failed: <code>`), profile. It is local and calls no API.

## Config

`~/.admobctl/config.json` (or `$ADMOBCTL_HOME/config.json`) holds no secrets. `--profile <name>` picks a profile.

| Command | Does |
|---|---|
| `admobctl config get [key]` | The resolved profile, or one key (dotted, e.g. `finance.revenueAccount`) |
| `admobctl config set <key> <value>` | Set a key: account, quotaProject, website, `websites.<alias>`, `aliases.<alias>`, features, `finance.<key>`, `check.<key>` (the error for an unknown key lists them all) |
| `admobctl config unset <key>` | Remove a key |
| `admobctl config path` | Print the config file's path |

## Errors

Every error has a message and a `fix:` line with the exact command. Exit codes: 0 ok, 1 error, 2 usage.
