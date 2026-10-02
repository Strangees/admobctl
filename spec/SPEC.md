# Revenue Journal, version 1

**Format identifier:** `revenue-journal/1` · **Spec version:** 1.0.0-draft.2 · **Status:** Draft, not yet stable

Revenue Journal is a small interchange format for the bookkeeping of platform revenue: money earned through ad
networks, app stores and similar platforms that pay out later. It describes that revenue as double-entry vouchers
(balanced debit and credit lines), so one file can be turned into an import for any accounting system, a
plain-text accounting journal or a spreadsheet.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be read as described in RFC 2119 and RFC 8174 when,
and only when, they appear in capitals.

## 1. Scope

In scope:

- **Accruals:** revenue earned in a period and not yet paid (for example one month of ad earnings).
- **Settlements:** a payout that clears earlier accruals, including fees and currency differences.
- **Adjustments:** corrections of earlier accruals (for example when estimated earnings are finalized).

Out of scope: invoices, customer and supplier ledgers, payroll, VAT returns, opening balances and full general ledgers.
A Revenue Journal file says how to book revenue; it does not say whether the books are right. Account numbers, VAT
codes and texts are chosen by the producer (usually from user configuration) and are not tax advice.

## 2. Terms

- **Producer:** software that writes Revenue Journal files (for example admobctl).
- **Consumer:** software that reads them (for example an exporter to an accounting system's import format).
- **Voucher:** one bookkeeping event; a set of lines that balance. Called *bilag*, *Beleg* or *journal entry* in
  accounting systems.
- **Line:** one debit or one credit to one account within a voucher.
- **Role:** what a line's account is for (§5), independent of any chart of accounts.

## 3. Data model

A **document** contains vouchers; a **voucher** contains lines.

### 3.1 Document

| Field | Type | Required | Meaning |
|---|---|---|---|
| `format` | string | yes | Exactly `revenue-journal/1` |
| `producer` | object | no | `{ "name": string, "version": string }` of the software that wrote the file |
| `generated_at` | string | no | RFC 3339 timestamp with offset, e.g. `2026-10-02T08:00:00Z` |
| `amounts` | object | no | How amounts are encoded (§4.1): `{ "encoding": "decimal" }` (the default when absent) or `{ "encoding": "integer", "scale": 2 }` |
| `vouchers` | array of Voucher | yes | May be empty |

### 3.2 Voucher

| Field | Type | Required | Meaning |
|---|---|---|---|
| `voucher_id` | string | yes | Identifies the voucher (§4.2) |
| `kind` | string | yes | `accrual`, `settlement` or `adjustment` |
| `date` | string | yes | Booking date, `YYYY-MM-DD` |
| `period` | object | yes | `{ "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" }`, inclusive: the earnings period the voucher covers |
| `currency` | string | yes | ISO 4217 code of every amount in the voucher, e.g. `NOK` |
| `status` | string | yes | `estimate` or `final` |
| `source` | string | yes | Revenue source (§6), e.g. `admob` |
| `description` | string | yes | Human-readable text for the voucher |
| `counterparty` | string | no | The paying party, e.g. `Google Ireland Limited` |
| `account_ref` | string | no | The source's own account identifier, e.g. a publisher ID |
| `attachments` | array of Attachment | no | Documentation for the voucher (§3.4) |
| `lines` | array of Line | yes | At least two |

### 3.3 Line

| Field | Type | Required | Meaning |
|---|---|---|---|
| `line` | integer | yes | 1, 2, 3 … in order within the voucher |
| `role` | string | yes | Account role (§5) |
| `debit` | amount | one of | Amount (§4.1) debited |
| `credit` | amount | one of | Amount (§4.1) credited |
| `account` | string | no | Account in the user's chart of accounts, e.g. `3125` or `Income:Ads:AdMob` |
| `account_name` | string | no | Name of that account |
| `vat_code` | string | no | VAT/tax code in the user's accounting system or country, e.g. `52` |
| `description` | string | no | Text for this line; consumers fall back to the voucher's `description` |
| `dimension` | string | no | A breakdown key such as an app, product or project, e.g. `example-quiz-ios` |
| `foreign_currency` | string | no | ISO 4217 code of the original currency, when it differs from the voucher's |
| `foreign_amount` | amount | no | Amount (§4.1) in `foreign_currency`; required when `foreign_currency` is set |

### 3.4 Attachment

| Field | Type | Required | Meaning |
|---|---|---|---|
| `path` | string | yes | Path relative to the Revenue Journal file, using `/`; MUST NOT be absolute or contain `..` |
| `media_type` | string | no | e.g. `text/html`, `text/csv`, `application/pdf` |
| `description` | string | no | What the file documents |

## 4. Rules

A file conforms to this spec only if it is valid against the JSON Schema (`schema/revenue-journal-1.json`) **and**
meets every rule below. Each rule has an ID used by the conformance fixtures.

- **RJ-SCHEMA:** the document is valid against the JSON Schema. The schema also enforces RJ-AMOUNT, RJ-ONE-SIDE,
  RJ-DATE, RJ-FOREIGN and the two-line minimum of RJ-LINES; the remaining rules need code. Rule checks compare
  amounts exactly in either encoding.

### 4.1 Amounts

Amounts are never JSON numbers with a fraction, so no consumer has to go through binary floating point. A document
uses one of two encodings, chosen by its `amounts` field:

| Encoding | `amounts` | 102.45 is written as | Use when |
|---|---|---|---|
| Decimal (default) | absent, or `{ "encoding": "decimal" }` | `"102.45"` | Humans read the file; most tools |
| Integer | `{ "encoding": "integer", "scale": 2 }` | `10245` | Tools that want numbers, not strings |

- **RJ-AMOUNT:**
  - Decimal encoding: amounts are strings of decimal digits with an optional `.` and 1–4 fraction digits: no sign,
    no exponent, no thousands separator (`"12.34"`, `"1000"`, `"0.5"`).
  - Integer encoding: amounts are JSON integers; the value is the integer × 10<sup>−scale</sup>. `scale` is an
    integer from 0 to 6 and is required. Integers MUST NOT exceed 9007199254740991 (2<sup>53</sup> − 1), so every
    common JSON parser reads them exactly.
- **RJ-POSITIVE:** every `debit`, `credit` and `foreign_amount` is greater than zero.
- **RJ-ONE-SIDE:** every line has exactly one of `debit` and `credit`.
- Decimal amounts SHOULD have the number of fraction digits of the currency's minor unit (ISO 4217), for example two
  for NOK, zero for JPY. In the integer encoding, `scale` SHOULD be the minor unit of the document's currencies; a
  producer that needs more precision MAY use a larger scale (for example 6 for micros).

### 4.2 Vouchers

- **RJ-BALANCE:** in every voucher, the sum of `debit` equals the sum of `credit`, compared exactly as decimals.
- **RJ-UNIQUE-ID:** `voucher_id` is unique within a document.
- **RJ-LINES:** a voucher has at least two lines, numbered 1, 2, 3 … without gaps, in array order.
- **RJ-PERIOD:** `period.from` is on or before `period.to`.
- **RJ-DATE:** `date`, `period.from` and `period.to` are real calendar dates (`2026-02-30` is invalid).
- **RJ-FOREIGN:** `foreign_amount` and `foreign_currency` are either both present or both absent.
- `voucher_id` SHOULD be stable: generating the same voucher again (same source, account, kind and period) SHOULD give
  the same `voucher_id`, so consumers can detect a voucher that was already booked. A recommended shape is
  `<source>:<account_ref>:<kind>:<period>`, e.g. `admob:pub-0000000000000001:accrual:2026-09`.
- An accrual's `date` SHOULD be the last day of its period.

### 4.3 Consumers

- Consumers MUST ignore fields they do not know (in JSON) and columns they do not know (in CSV).
- Consumers MUST reject a file whose `format` they do not support.
- Consumers that post to an accounting system SHOULD refuse a line whose `role` they cannot map to an account,
  rather than guessing.

## 5. Roles

A role says what a line's account is for. Consumers map roles to accounts; `account` on a line, when present, is the
producer's suggestion and takes precedence.

| Role | Normal side | Meaning |
|---|---|---|
| `earnings_receivable` | debit in accruals, credit in settlements | Earned but not yet paid by the platform |
| `revenue` | credit | Revenue earned |
| `bank` | debit | Where a payout lands |
| `fees` | debit | Fees or commission the platform kept |
| `withholding_tax` | debit | Tax the platform withheld |
| `fx_gain` | credit | Gain from a currency difference |
| `fx_loss` | debit | Loss from a currency difference |
| `estimate_adjustment` | either | Difference between estimated and final revenue |

Producers MAY use other roles prefixed with `x-` (for example `x-bonus`). New standard roles may be added in a minor
version of this spec (§8).

## 6. Sources

`source` is a lowercase identifier: letters, digits and `-`, starting with a letter. Known values:

| Value | Platform |
|---|---|
| `admob` | Google AdMob |
| `app-store` | Apple App Store |
| `google-play` | Google Play |

Other values are allowed. To add a value to this list, open a pull request.

## 7. Encodings

### 7.1 JSON

A document is one JSON object as described in §3, encoded as UTF-8. Amounts use the decimal or the integer encoding
(§4.1). Media type: `application/json`. Recommended file extension: `.rj.json`.

### 7.2 CSV

CSV carries vouchers and lines, one row per line. It does not carry `producer`, `generated_at`, `amounts` or
`attachments`; use JSON when those matter. CSV amounts always use the decimal encoding, written without quotes.

- RFC 4180: comma separator, `"` for quoting, CRLF or LF line endings, UTF-8. Producers SHOULD NOT write a byte order
  mark; consumers MUST accept one.
- The first row is a header of field names. Consumers MUST find columns by header name, not position.
- Every row has a `format` column with the value `revenue-journal/1`.
- Voucher fields are repeated on every row of the voucher. `period` is written as two columns, `period_from` and
  `period_to`. Rows of one voucher are consecutive.
- An empty cell means the field is absent.
- Producers SHOULD write the columns in this order:

```
format,voucher_id,kind,date,period_from,period_to,currency,status,source,description,counterparty,account_ref,line,role,account,account_name,debit,credit,vat_code,line_description,dimension,foreign_currency,foreign_amount
```

The line's `description` is written as `line_description`, since the voucher's `description` already uses that name.
Media type: `text/csv`. Recommended file extension: `.rj.csv`.

## 8. Versioning

- The format identifier carries the major version: `revenue-journal/1`.
- **Minor changes** keep the identifier: new optional fields, new standard roles, new known `source` values and
  clarifications. Version 1 consumers keep working because they ignore unknown fields (§4.3).
- **Major changes** get a new identifier (`revenue-journal/2`): removing or renaming a field, making an optional field
  required, or changing what a field means.
- Spec versions are numbered `1.minor.patch` and listed in `CHANGELOG.md`.

## 9. Conformance

- A **conforming file** is valid against the schema and meets every rule in §4.
- A **conforming producer** writes only conforming files.
- A **conforming consumer** accepts every file in `conformance/valid/` and rejects every file in `conformance/invalid/`,
  each for the rule listed in `conformance/manifest.json`.

## 10. Security and privacy

Revenue Journal files contain financial data. They MUST NOT contain credentials or access tokens. Producers SHOULD NOT
include personal data beyond what bookkeeping needs (typically the counterparty's name). Consumers MUST NOT follow an
attachment `path` outside the directory of the file.
