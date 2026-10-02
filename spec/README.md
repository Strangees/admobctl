# Revenue Journal

An open interchange format for bookkeeping platform revenue: ad networks, app stores and other platforms that pay
out later. One file describes the revenue as balanced double-entry vouchers, so it can be turned into an import for
any accounting system, a plain-text accounting journal or a spreadsheet.

**Status:** draft (`revenue-journal/1`, spec version 1.0.0-draft.2). Fields may still change before 1.0.

| Path | Contents |
|---|---|
| [SPEC.md](SPEC.md) | The specification: data model, rules, CSV and JSON encodings, versioning |
| [schema/revenue-journal-1.json](schema/revenue-journal-1.json) | JSON Schema (draft 2020-12) for the JSON encoding |
| [examples/](examples/) | A month of AdMob revenue from estimate to payout, a Norwegian chart of accounts, an App Store producer, and the CSV encoding |
| [conformance/](conformance/) | Valid and invalid files with the expected verdict and rule in `manifest.json` |
| [CHANGELOG.md](CHANGELOG.md) | Spec versions |

## Why

Every accounting system wants its own import file, and every revenue platform reports differently. With one format
in the middle, a revenue tool writes Revenue Journal once and an exporter maps it to each accounting system once.

## Implementations

- [admobctl](../README.md): producer (Google AdMob) and reference implementation.

## Home

This folder lives in the admobctl repository while the format settles. It is self-contained (nothing in it depends on
admobctl) and will move to its own repository when a second tool produces or consumes it, or at 1.0.

## Licence

The specification text is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The schema,
examples and conformance files are licensed under the MIT licence. See [LICENSE](LICENSE).
