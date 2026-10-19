# Validation performed

Validated on 18 October 2026 using Node.js 24.19.0 and a real temporary MongoDB 7.0.24 instance. All datasets were synthetic; no production cluster, actual problematic workbook, or hosting account was accessed.

## Passing checks

- All **31 tests** pass when the optional MongoDB integration test is enabled. The default test command passes 30 tests and skips the MongoDB scenario unless TEST_MONGODB_URI is set.
- Generated XLSX, binary XLS and UTF-16 exports verify header detection after preambles, short-row padding, preservation of administrator columns, missing/null-like pattern ID recovery, and shifted language codes.
- Date-repair cases include JavaScript Date cells, Excel serial numbers, numeric serial strings, ISO dates/timestamps, DD-MM-YYYY, MM/DD/YYYY and named-month timestamps. A valid existing language is retained; a valid url_pattern_order fallback is used; unresolved nonempty invalid language values are flagged and cannot be activated.
- Administrator tests cover exact decimal/scientific ID normalization, misplaced ID recovery and overwrite, historical lookup preference, workbook fallback around conflicting historical references, unresolved conflicting names, and private-keyword metadata updates.
- Coverage tests cover full domain/basis splitting, priority, wildcards, phrase adjacency, singular/plural URL forms, exact locks, repeated fragments, promote handling, rules, keyword parsing and CSV escaping.
- Real API tests cover authentication, unknown-account rejection, CSRF, local import previews, queued replacement, search, both coverage reports, duplicate URL aggregation, weighted performance averages, live-pair eligibility, deletion exports, manual replacements, duplicate rejection, failed-import isolation, alignment preview diagnostics and blocked activation of unresolved rows.
- Browser tests cover login, every page, desktop/mobile layout, concatenation, running coverage, and submitting an actual replacement through the Dashboard. No browser JavaScript page errors were recorded. Desktop and mobile screenshots were inspected internally.
- The frontend production build succeeds. Backend syntax checks succeed. The existing SQLite exporter was verified using a synthetic old database with keyword mappings.

## Storage and replacement regression

A synthetic legacy database contained two complete revisions of 200 patterns and 4,000 keyword mappings each, plus temporary processing rows and the previous keyword indexes. Optimization reduced combined document/index usage from about **4.61 MB to 1.24 MB**, approximately **73%** in that fixture. This measures that fixture, not the user's actual Atlas data.

Three identical replacement uploads each left exactly **200 active patterns and 4,000 keyword mappings**, with only one pattern revision. Active document data measured **1,095,030 bytes** each time. Combined document/index size varied slightly (roughly 1.26 MB) because index page allocation can vary; exact total-byte equality is not promised.

The regression also verifies that omitted patterns are removed, an explicit keyword list replaces old mappings, omitting the keyword column retains only live mappings, stale performance actions are rejected, invalid alignment cannot activate, an injected failure after clearing active rows restores the previous dataset, and a simulated interruption is recovered on restart. A database with no accepted dataset archives incomplete legacy data before cleanup. The shipped integration scenario uses its own random database and a temporary processing directory.

## Synthetic processing check

| Measurement | Result |
| --- | --- |
| Pattern catalog | 5,000 |
| Unique URLs | 10,000 |
| Import preview, including queue wait | 2.09 seconds |
| Coverage, including queue wait | 1.26 seconds |
| Peak coverage-worker RSS | 111.2 MiB |
| Mean / maximum concurrent health latency | 2.8 / 13.5 ms |

All 10,000 URLs matched correctly. These numbers came from the test container and synthetic data. They exclude total API/MongoDB/OS memory. Large workbooks, real keyword catalogs, disk speed, network latency and the user's host limits can change results.

## Limits of this validation

Atlas quota handling was tested through injected failures and real local MongoDB cleanup/replacement, not a full Atlas cluster. Actual cloud quota reclamation, disk capacity, HTTPS, container deployment and host limits need verification in the user's environment. Backups and local reports require persistent backend storage. A sufficiently large active dataset plus indexes can still exceed 512 MB. These changes prevent retained-copy growth; they cannot guarantee every 200-MB source file fits a free cluster.
