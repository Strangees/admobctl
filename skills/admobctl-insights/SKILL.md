---
name: admobctl-insights
description: Use when the user asks how their AdMob monetization is doing, which apps, ad units, countries or formats perform well or badly, why AdMob revenue changed, or what to improve (fill rate, match rate, show rate, eCPM, mediation).
---

# Analyzing AdMob monetization

## Get the data

Call `admobctl_insights` (CLI: `admobctl insights`). The default is ad units over the last 30 complete days,
compared with the 30 days before. Use `by: "app" | "country" | "format" | "platform"` or `from`/`to` when the
question asks for it. Drill down with `admobctl_network_report` only when the insights output cannot answer the question.

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
