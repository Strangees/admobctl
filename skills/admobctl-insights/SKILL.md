---
name: admobctl-insights
description: Use when the user asks how their AdMob monetization is doing, which apps, ad units, countries or formats perform well or badly, why AdMob revenue changed, or what to improve (fill rate, match rate, show rate, eCPM, mediation).
---

# Analyzing AdMob monetization

## Get the data

Call `admobctl_insights` (CLI: `admobctl insights`). The default is ad units over the last 30 complete days,
compared with the 30 days before. Use `by: "app" | "country" | "format" | "platform"` or `from`/`to` when the
question asks for it. Drill down with `admobctl_network_report` only when the insights output cannot answer the question.

For "is everything OK?", "did something break?" or a daily check, call `admobctl_check` first: it compares the last
complete day with the week before and returns `findings` only for real drops. No findings means nothing dropped by the
threshold; say so plainly and do not go looking for problems in `thin` rows.

For narrower questions use the curated analyses, which follow the same highlights/summary shape:
`admobctl_analyze_versions` (did an SDK upgrade or app release hurt match or show rate),
`admobctl_analyze_consent` (how much traffic runs under consent/RDP/limited-ads restrictions and at what eCPM, per app
in one call) and `admobctl_analyze_waterfall` (which mediation lines earn, which sit idle).

Rows marked `enough_data: false` in the versions and consent analyses have too few requests to judge. Show them if
asked, but do not report their rates as problems. Compare restricted and unrestricted eCPM within one app, never
across apps.

If `admobctl_check_app_ads` returns `unknown-website` for an Android app, the website could not be fetched from
Google Play. Do not guess it: ask the user for the developer website and pass it as `website`, or have them save it
with `admobctl config set websites.<alias> <url>`.

## Present it

1. **Headline:** total estimated earnings for the period and the change vs the previous period.
2. **Problems, most valuable first:** take them from `highlights`, giving the unit and its numbers
   (e.g. "Quiz banner (Android): 20% match rate on 40,000 requests").
3. **What is working:** the top earners, with their share.
4. **Next step per problem** (table below).
5. One line saying the figures are estimated earnings.

Every number comes from the tool output, or from simple arithmetic on it. Do not present industry benchmarks as
facts about the user's account. If something does not add up, say what and stop; do not speculate at length.

| Highlight | What it usually means | Next step |
|---|---|---|
| `low-fill` (low match rate, many requests) | Demand does not match the requests | Check mediation and bidding sources, eCPM floors, blocked categories, request frequency |
| `low-show-rate` | Ads load but are not shown | Check that ads are shown soon after loading and are not loaded for screens the user never sees |
| `swing-down` / `gone` | Revenue drop | Break down by country or format with `admobctl_network_report`, and check app releases |
| `swing-up` / `new` | Revenue gain | Name it; confirm it is not a one-off spike |
| `bottom` | Traffic with little revenue | Consider the format or placement, or removing the unit |
| `low-show-rate` / `low-match-rate` on a version | The SDK or app release behaves differently | Compare release notes and the ad-loading code between that version and the others; check adapter versions |
| `restricted` (consent) | Restricted traffic earns less | Review the consent message (UMP) and its acceptance rate; numbers only, no legal advice |
| `idle` (waterfall) | A line gets requests but never serves | Check the line's ad unit mapping and the network's account; remove the line if it stays idle |
| `low-fill` (waterfall) | A line rarely fills, adding latency | Lower its position or eCPM floor, or remove it |
