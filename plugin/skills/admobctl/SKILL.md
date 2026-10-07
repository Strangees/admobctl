---
name: admobctl
description: Use when the user asks about their Google AdMob account - apps, ad units, earnings, revenue, impressions, eCPM, fill or match rate, mediation or ad sources - or when an admobctl command or admobctl MCP tool fails with an auth or setup error.
---

# admobctl

Read-only access to the user's AdMob account through the `admobctl` MCP tools (preferred) or the `admobctl` CLI.

## Pick the tool

| User asks | MCP tool | CLI |
|---|---|---|
| Earnings for a month, per app, for bookkeeping | `admobctl_finance_month` (then follow admobctl-finance) | `admobctl finance month YYYY-MM` |
| Earnings over several months / year to date | `admobctl_finance_range` | `admobctl finance range --from … --to …` |
| How is this month pacing, where will it end | `admobctl_finance_forecast` | `admobctl finance forecast` |
| What is my balance, what will Google pay me | `admobctl_finance_balance` | `admobctl finance balance` |
| A file for an accounting import (Revenue Journal JSON/CSV) | `admobctl_finance_export` | `admobctl finance export --month YYYY-MM` |
| Is everything OK, did revenue or fill drop since yesterday | `admobctl_check` | `admobctl check` (exits 1 on a drop) |
| Is the setup sound: unused ad units, broken mediation groups, apps needing action | `admobctl_lint` | `admobctl lint` (exits 1 on a problem) |
| How is monetization doing, what underperforms, why did revenue change | `admobctl_insights` (then follow admobctl-insights) | `admobctl insights --last 30d` |
| A specific breakdown (by country, format, date, ad unit…) | `admobctl_network_report` | `admobctl report network --from … --by …` |
| Ad sources / mediation | `admobctl_mediation_report` | `admobctl report mediation --from … --by ad-source` |
| Mediation waterfall, which lines earn, idle lines | `admobctl_analyze_waterfall` | `admobctl analyze waterfall` |
| Which countries and formats earn, fill badly or pay well | `admobctl_analyze_geo` | `admobctl analyze geo` |
| When did revenue change, is there a weekday pattern | `admobctl_analyze_trend` | `admobctl analyze trend [--by app]` |
| Did an SDK upgrade or app release hurt fill / show rate | `admobctl_analyze_versions` | `admobctl analyze versions --by sdk\|app\|os` |
| Consent / non-personalized ads / RDP impact on eCPM | `admobctl_analyze_consent` | `admobctl analyze consent` |
| How mediation is set up: groups, lines, A/B tests | `admobctl_list_mediation_groups` | `admobctl mediation-groups list` / `show <group>` |
| Which ad networks / adapters exist, mapping settings | `admobctl_list_ad_sources`, `admobctl_list_adapters` | `admobctl ad-sources list` / `adapters <source>` |
| An ad unit's third-party mappings | `admobctl_list_ad_unit_mappings` | `admobctl ad-units mappings <ad-unit>` |
| App-promotion campaigns: installs, cost, CPI | `admobctl_campaign_report` | `admobctl report campaign --from …` |
| Which apps / ad units exist | `admobctl_list_apps`, `admobctl_list_ad_units` | `admobctl apps list` |
| Is app-ads.txt set up; unexplained limited ad serving | `admobctl_check_app_ads` | `admobctl apps app-ads [--website <url>]` |

app-ads.txt on Android: Google Play listings cannot be read, so Android apps show `unknown-website` until the developer
website is added by hand. Do not guess it. Ask the user for the URL and pass it as `website` (CLI: `--website <url>`), or
have them save it once with `admobctl config set websites.<alias> <url>`; later checks then need no argument.

Refer to apps by their alias (e.g. `my-game-ios`) from `admobctl_list_apps`. Dates are `YYYY-MM` or `YYYY-MM-DD`;
"last month" means the previous calendar month.

If the MCP tools are not available, run the CLI with `-o json` and read the JSON.

## Answering

- Use the numbers the tools return. Do not invent figures, and say so when the data cannot answer the question.
- All earnings are estimates. Say so whenever you report money.
- One good call usually answers the question. If results look inconsistent, report what you saw instead of investigating at length.

## Changes (CLI only)

The MCP tools only read. admobctl's write commands (`apps create`, `ad-units create|map|map-batch`,
`mediation-groups create|set-line|add-line|set-ad-units|experiment start|stop`) print a plan and send nothing unless
`--yes` is given. Run one without `--yes`, show the user the plan, and add `--yes` only after the user explicitly
confirms that exact change. They need the admob.monetization scope and Google allowlisting; see `references/commands.md`.

## Errors and setup

Every error ends with `Fix: <command>`. Show the user that exact command; do not paraphrase it or invent another.
For anything about sign-in, scopes, the quota project or APIs, call `admobctl_setup_status` (CLI: `admobctl setup
status`) and run its `next_command` exactly. These are `admobctl setup …` commands, or `admobctl auth login …` for a
profile on the user's own OAuth client; never improvise gcloud commands. Commands with `--yes` change the user's setup, so show them first. The browser sign-in
(`admobctl setup login --yes`) must run in the user's own terminal. Service accounts are not supported by the AdMob API. If `GOOGLE_APPLICATION_CREDENTIALS` selects one, or selects credentials that are missing or lack scopes (a sign-in writes a different file), show the full manual fix: the user must unset it in their terminal before login. There is no automated `next_command` for this prerequisite.

Ad sources, adapters, mediation groups, ad unit mappings and campaign reports use AdMob API v1beta, which Google
limits to allowlisted accounts for some methods. A "v1beta" permission error means the account lacks that access,
not that setup is wrong: show its fix line and answer from the other tools.

Full command and flag reference: `references/commands.md`.
