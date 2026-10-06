# Live test prompt

A read-only end-to-end test of a build against your own AdMob account. Paste everything below the line into Claude Code
or Codex, in a session at the root of this repository with the admobctl plugin installed.

---

You are testing admobctl (the AdMob CLI + MCP plugin) against my real AdMob account, end to end, and reporting back what works and what doesn't. Work from the root of this repository.

## Hard rules
- READ-ONLY. Never pass `--yes` to any command. Write commands (apps create, ad-units create/map/map-batch, mediation-groups create/set-line/add-line/set-ad-units, experiment start/stop) may only be run WITHOUT `--yes`, so they print a plan and send nothing. If any output suggests a change was actually applied, stop immediately and tell me.
- Do not run `auth login`, `auth logout`, `config set` or `config unset`, and don't run any gcloud command that changes anything. If a test needs a setup change, report the Fix line instead of running it.
- Do not print access tokens. Keep earnings figures in the report rounded, and don't paste my email or phone number.
- If a tool fails, record the exact error code, message and Fix line, then continue with the next test. Don't stop at the first failure.

## Part A: MCP tools (the admobctl plugin's tools in this session)
Call every tool once with sensible arguments. Use real aliases, ad units and groups from the list tools. Use last month for month-based tools, and the last 30 days elsewhere:
admobctl_list_accounts, admobctl_list_apps, admobctl_list_ad_units, admobctl_network_report, admobctl_mediation_report,
admobctl_finance_month (with and without include_journal), admobctl_finance_range (last 3 months), admobctl_finance_export,
admobctl_finance_forecast, admobctl_finance_balance, admobctl_setup_status, admobctl_insights, admobctl_check, admobctl_lint,
admobctl_analyze_versions, admobctl_analyze_consent, admobctl_analyze_waterfall, admobctl_analyze_geo, admobctl_analyze_trend,
admobctl_campaign_report, admobctl_list_ad_sources, admobctl_list_adapters, admobctl_list_mediation_groups,
admobctl_list_ad_unit_mappings, admobctl_check_app_ads.
If fewer than 25 admobctl tools are available, list which ones are missing (the session may need a restart).

## Part B: CLI (`node dist/admobctl.mjs …`)
1. `--version`, then `auth status`, `auth doctor` and `setup status`. Doctor should list admob.readonly, admob.monetization and adsense.readonly.
2. Reads: `accounts list`, `apps list`, `apps app-ads`, `ad-units list`, `ad-units mappings <one ad unit>`, `ad-sources list`, `ad-sources adapters <one source>`, `mediation-groups list`, `mediation-groups show <one group>`, `mediation-groups export <one group>`.
3. Reports: `report network --from <last month> --by app`, `report mediation --from <last month> --by app`, `report campaign --from <last month>`, and one report with `--currency USD`.
4. Finance: `finance month <last month>` (plus `--as journal`, `--as csv`, `--as json`), `finance range --from <3 months ago> --to <last month>`, `finance forecast`, `finance balance` (plus `--output json`), `finance export --month <last month>` (stdout only, no `--out`).
5. Analysis: `insights`, `check`, `lint`, and `analyze versions | consent | waterfall | geo | trend`.
6. `audit-log`, `config get`, `config path`.
7. Write commands, as dry runs only (no `--yes`). Read each command's `--help` first and use real IDs from step 2:
   - `apps create`
   - `ad-units create`
   - `ad-units map`
   - `mediation-groups set-line` (change a manual CPM)
   - `mediation-groups add-line`
   - `mediation-groups set-ad-units`
   - `mediation-groups experiment start`
   For each, confirm it printed a plan and said nothing was sent. Then run `audit-log` again and confirm no new entries.

## Part C: consistency checks
- The admobctl_finance_month total equals `finance month` for the same month, and the sum of `finance range` months equals its stated total.
- `finance balance` matches the "unpaid balance" I see in AdMob → Payments. Show me the number and ask me to confirm; don't claim it matches.
- MCP and CLI agree on app aliases and on the ad unit count.

## Report format
1. A table with one row per test: Area | Test | Result (✅ works / ⚠️ works with a caveat / ❌ fails) | Note. The Note gives the error code and Fix line for failures, or the caveat.
2. "Expected limitations": failures caused by known account restrictions, such as v1beta allowlisting (BETA_ACCESS_DENIED), no app-promotion campaigns (CAMPAIGN_REPORT_REJECTED), or Android apps without a developer website in app-ads.
3. "Real bugs": anything that looks wrong in admobctl itself, such as crashes, wrong numbers, confusing errors, MCP and CLI disagreeing, or a missing Fix line. Include the exact command or tool call so I can reproduce it.
4. A one-paragraph summary.
