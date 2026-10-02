# admobctl command reference

Global flags (any command): `-o json|table|csv|markdown` (default: table on a TTY, json when piped),
`--profile <name>`, `--account pub-…`, `-v` (debug logs to stderr). Run `admobctl <cmd> --help` for details.

## Auth

| Command | Purpose |
|---|---|
| `admobctl auth doctor` | Checks credentials → token → scope → quota project → API → account → apps (warns about apps marked action required) → beta (which v1beta reads the account can use; warning only); prints `fix:` for each failure. Exit 1 if any check fails. |
| `admobctl auth status` | Active mode (adc/oauth), quota project, scopes, account |
| `admobctl auth login --client-id <id> --client-secret <s> [--write]` | Own Desktop OAuth client; refresh token goes to the macOS Keychain. Switches the profile to `oauth`. `--write` also grants admob.monetization. |
| `admobctl auth logout` | Revoke and forget the OAuth login; back to gcloud ADC |

gcloud ADC setup (the default):

```bash
gcloud auth application-default login --scopes=https://www.googleapis.com/auth/admob.readonly,https://www.googleapis.com/auth/cloud-platform
gcloud auth application-default set-quota-project <PROJECT_ID>
gcloud services enable admob.googleapis.com --project <PROJECT_ID>
```

Service accounts are not supported by the AdMob API.

## Inventory

| Command | Output |
|---|---|
| `admobctl accounts list` | publisherId, currencyCode, reportingTimeZone |
| `admobctl apps list` | alias, name, platform, appId, storeId, approval (JSON: APPROVED, IN_REVIEW, ACTION_REQUIRED) |
| `admobctl ad-units list [--app <alias>]` | app alias, name, format, adUnitId |

v1beta (read-only, `admob.readonly`; Google may require allowlisting, a 403 says so):

| Command | Output |
|---|---|
| `admobctl ad-units mappings <ad-unit>` | id, name, adapterId, state, settings (adapter setting ID → value) |
| `admobctl ad-sources list` | title, adSourceId |
| `admobctl ad-sources adapters <ad-source>` | adapter title, adapterId, platform, formats, settings (id, label, required) |
| `admobctl mediation-groups list [--app] [--ad-source] [--format] [--platform] [--state]` | name, id, state, platform, format, adUnits, regions, experiment (running/none), lines |
| `admobctl mediation-groups show <group>` | the group's lines: name, adSource, cpmMode, cpm (USD, manual lines only), state, variant (A/B) |

Apps take an alias (`<name>-<platform>`, e.g. `my-game-ios`), app ID, numeric ID or exact name.
Custom alias: `admobctl config set aliases.<alias> <appId>`.

## Reports

```bash
admobctl report network   --from YYYY-MM[-DD] [--to …] [--by dims] [--metrics m] [--filter k=v,v] [--max-rows n]
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
```

- Per-app amounts are rounded so they sum exactly to the total.
- `complete: false` means the month has not ended (account time zone).
- `--as journal` prints tab-separated Bilagsjournal rows (Bilag, Dato, Kilde, Beskrivelse, Konto, Kontonavn,
  Debet, Kredit, MVA-behandling, Motpart, Status, Merknad), dated at month-end: debit the receivable (default 1509),
  credit revenue (default 3120) per app.
- Finance config: `admobctl config set finance.<key> <value>`, where key is one of receivableAccount, revenueAccount,
  receivableAccountName, revenueAccountName, vatTreatment, counterparty, decimalSeparator (`.` or `,`).

## Insights

```bash
admobctl insights [--last 30d | --from … --to …] [--by ad-unit|app|country|format|platform] [--swing 30]
```

Returns rows (earnings, share, change vs the previous equal-length period, eCPM, request RPM, match rate, show rate, CTR),
highlights (top, bottom, low-fill, low-show-rate, swing-up, swing-down, new, gone) and a plain-language summary.

## Analyze

```bash
admobctl analyze versions  [--by sdk|app|os] [--app <alias>] [--last 30d | --from … --to …]
admobctl analyze consent   [--app <alias>] [--currency X] [--last 30d | --from … --to …]
admobctl analyze waterfall [--app <alias>] [--group <name|id>] [--currency X] [--last 30d | --from … --to …]
```

- `versions`: requests, share of the group (platform, or app for app versions), match rate, show rate, CTR per
  version. Highlights `low-match-rate` / `low-show-rate` when a version with ≥5% of its group's traffic does ≥20%
  worse than the group's other versions. No earnings (the API does not split earnings by version).
- `consent`: per serving restriction: requests and share, earnings, eCPM, `ecpm_vs_unrestricted`, match and show
  rate; `restricted_request_share` overall. Data from 2021-03-13.
- `waterfall`: `groups` (earnings per mediation group) and `rows` (one per ad source instance: observed `ecpm`,
  earnings and `earnings_share` of the group, requests, match rate, impressions), sorted by group earnings then eCPM.
  Highlights `top` (per group), `idle` (requests but no impressions), `low-fill` (<2% match rate on ≥5% of the group's requests).

## MCP tools (`admobctl mcp`)

admobctl_list_accounts, admobctl_list_apps, admobctl_list_ad_units, admobctl_network_report,
admobctl_mediation_report, admobctl_finance_month, admobctl_finance_range, admobctl_insights,
admobctl_analyze_versions, admobctl_analyze_consent, admobctl_analyze_waterfall, admobctl_campaign_report,
admobctl_list_ad_sources, admobctl_list_adapters (`ad_source`), admobctl_list_mediation_groups,
admobctl_list_ad_unit_mappings (`ad_unit`).
They take the same arguments as the CLI, in snake_case: `max_rows`, `include_journal`, `last_days`.
Reports default to 200 rows.

## Write commands (v1beta; CLI only)

Need the `admob.monetization` scope (`gcloud auth application-default login --scopes=…admob.readonly,…admob.monetization,…cloud-platform`
or `admobctl auth login --write`) and Google allowlisting (403 → contact the AdMob account manager).
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

## Errors

Every error has a message and a `fix:` line with the exact command. Exit codes: 0 ok, 1 error, 2 usage.
