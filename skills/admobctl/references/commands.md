# admobctl command reference

Global flags (any command): `-o json|table|csv|markdown` (default: table on a TTY, json when piped),
`--profile <name>`, `--account pub-…`, `-v` (debug logs to stderr). Run `admobctl <cmd> --help` for details.

## Auth

| Command | Purpose |
|---|---|
| `admobctl auth doctor` | Checks credentials → token → scope → quota project → API → account; prints `fix:` for each failure. Exit 1 if any check fails. |
| `admobctl auth status` | Active mode (adc/oauth), quota project, scopes, account |
| `admobctl auth login --client-id <id> --client-secret <s>` | Own Desktop OAuth client; refresh token goes to the macOS Keychain. Switches the profile to `oauth`. |
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
| `admobctl apps list` | alias, name, platform, appId, storeId |
| `admobctl ad-units list [--app <alias>]` | app alias, name, format, adUnitId |

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

## MCP tools (`admobctl mcp`)

admobctl_list_accounts, admobctl_list_apps, admobctl_list_ad_units, admobctl_network_report,
admobctl_mediation_report, admobctl_finance_month, admobctl_finance_range, admobctl_insights.
They take the same arguments as the CLI, in snake_case: `max_rows`, `include_journal`, `last_days`.
Reports default to 200 rows.

## Errors

Every error has a message and a `fix:` line with the exact command. Exit codes: 0 ok, 1 error, 2 usage.
