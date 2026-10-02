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
| How is monetization doing, what underperforms, why did revenue change | `admobctl_insights` (then follow admobctl-insights) | `admobctl insights --last 30d` |
| A specific breakdown (by country, format, date, ad unit…) | `admobctl_network_report` | `admobctl report network --from … --by …` |
| Ad sources / mediation | `admobctl_mediation_report` | `admobctl report mediation --from … --by ad-source` |
| Mediation waterfall, which lines earn, idle lines | `admobctl_analyze_waterfall` | `admobctl analyze waterfall` |
| Did an SDK upgrade or app release hurt fill / show rate | `admobctl_analyze_versions` | `admobctl analyze versions --by sdk\|app\|os` |
| Consent / non-personalized ads / RDP impact on eCPM | `admobctl_analyze_consent` | `admobctl analyze consent` |
| How mediation is set up: groups, lines, A/B tests | `admobctl_list_mediation_groups` | `admobctl mediation-groups list` / `show <group>` |
| Which ad networks / adapters exist, mapping settings | `admobctl_list_ad_sources`, `admobctl_list_adapters` | `admobctl ad-sources list` / `adapters <source>` |
| An ad unit's third-party mappings | `admobctl_list_ad_unit_mappings` | `admobctl ad-units mappings <ad-unit>` |
| App-promotion campaigns: installs, cost, CPI | `admobctl_campaign_report` | `admobctl report campaign --from …` |
| Which apps / ad units exist | `admobctl_list_apps`, `admobctl_list_ad_units` | `admobctl apps list` |

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
For anything auth-related, suggest `admobctl auth doctor`, which checks credentials, scope, quota project, API access
and account, and prints a fix for each failure. Service accounts are not supported by the AdMob API.

Ad sources, adapters, mediation groups, ad unit mappings and campaign reports use AdMob API v1beta, which Google
limits to allowlisted accounts for some methods. A "v1beta" permission error means the account lacks that access,
not that setup is wrong: show its fix line and answer from the other tools.

Full command and flag reference: `references/commands.md`.
