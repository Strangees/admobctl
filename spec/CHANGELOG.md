# Changelog

Spec versions of Revenue Journal (`revenue-journal/1`). See SPEC.md §8 for what counts as a minor or major change.

## 1.0.0-draft.2 — 2026-10-02

Integer encoding for amounts: a document with `"amounts": { "encoding": "integer", "scale": n }` writes every amount
as a JSON integer in units of 10^-n. Decimal strings stay the default. CSV always uses decimals.

## 1.0.0-draft.1 — 2026-10-02

First draft: document, voucher, line and attachment model; rules RJ-SCHEMA, RJ-AMOUNT, RJ-POSITIVE, RJ-ONE-SIDE,
RJ-BALANCE, RJ-UNIQUE-ID, RJ-LINES, RJ-PERIOD, RJ-DATE and RJ-FOREIGN; standard roles; known sources `admob`,
`app-store` and `google-play`; JSON and CSV encodings; JSON Schema, examples and conformance fixtures.
