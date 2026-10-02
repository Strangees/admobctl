---
name: admobctl-finance
description: Use when the user needs AdMob earnings for bookkeeping, accounting, a monthly close, invoicing or tax reporting, or asks for journal entries, bilag or bilagsjournal rows for AdMob revenue.
---

# AdMob earnings for bookkeeping

## The estimate rule

The AdMob API only exposes **estimated** earnings. Finalized earnings and payments are not available.
Every answer that contains money says: *estimated; reconcile against AdMob Payments (finalized)*.
If the tool returns `complete: false`, say the month is not over yet and the figures will change.

## Monthly earnings

1. Call `admobctl_finance_month` with `month: "YYYY-MM"` (CLI: `admobctl finance month YYYY-MM`).
2. Report each app's `earnings` and the `total` in the returned currency, exactly as returned. The per-app amounts
   are already rounded so they add up to the total, so do not re-round or recompute them from micros.

For a range or year-to-date, use `admobctl_finance_range` (CLI: `admobctl finance range --from YYYY-MM --to YYYY-MM`).

## A file for an accounting import

When the user wants a file their accounting system can import (not rows to paste), call `admobctl_finance_export` with
`month` (or `from` and `to`) and `as: "json"` or `"csv"`. It returns the whole Revenue Journal file as `content`: save
or show it unchanged, do not rebuild it from other tools' numbers. CLI: `admobctl finance export --month YYYY-MM --out <file>`.

## Journal rows (bilagsjournal)

Call `admobctl_finance_month` with `include_journal: true` and show the returned `journal_tsv` **verbatim** inside a
code block. It is tab-separated, paste-ready, and has all twelve columns in order:
Bilag, Dato, Kilde, Beskrivelse, Konto, Kontonavn, Debet, Kredit, MVA-behandling, Motpart, Status, Merknad.
Do not retype it, reformat it into another table, or drop columns.

The CLI prints the same block: `admobctl finance month YYYY-MM --as journal`.

- Rows are dated at month-end: debit the receivable (default 1509), credit revenue (default 3120) per app.
- `Bilag` is empty for the user to number. `MVA-behandling` comes from the user's config. Do not suggest a VAT
  treatment; it is the user's or their accountant's call.
- To change accounts, names, VAT text or the decimal separator: `admobctl config set finance.<key> <value>`
  (receivableAccount, revenueAccount, receivableAccountName, revenueAccountName, vatTreatment, counterparty,
  decimalSeparator).
