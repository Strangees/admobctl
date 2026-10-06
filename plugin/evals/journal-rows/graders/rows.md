---
type: llm
weight: 2
---

The answer gives paste-ready Bilagsjournal rows dated 2026-09-30 (month-end): a debit of 102.45 on account 1509 and
credits on account 3120 per app (60.13, 30.00, 12.32) that add up to 102.45, with amounts exactly as returned by the tool.
The rows must include ALL twelve columns in this order: Bilag, Dato, Kilde, Beskrivelse, Konto, Kontonavn, Debet, Kredit,
MVA-behandling, Motpart, Status, Merknad (a tab-separated block or a table with exactly these columns). In a
tab-separated block, the Bilag and MVA-behandling cells are expected to be empty, so data lines start with a tab and
contain two adjacent tabs; empty cells are not missing columns.
It must say the figures are estimates to reconcile against AdMob Payments (finalized).
Fail if any column is missing, renamed or reordered, if amounts/accounts/date differ, if the estimate caveat is missing,
or if it states a VAT treatment as fact instead of leaving MVA-behandling to the user's own configuration.
