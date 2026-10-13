# Private Supercrew reference verification

Public parser tests use synthetic `TEST` records. Optional reference tests require both an original XLSX path and an independently reviewed JSON expectation manifest. Keep both files outside the repository and run these tests only in a private local terminal: assertion failures can display source values. Do not supply these environment variables to public GitHub Actions or upload their output as artifacts.

| Reference | XLSX environment variable | Manifest environment variable |
| --- | --- | --- |
| Original source report | `SUPERCREW_REFERENCE_XLSX` | `SUPERCREW_REFERENCE_MANIFEST` |
| Timesheet export | `SUPERCREW_TIMESHEET_REFERENCE_XLSX` | `SUPERCREW_TIMESHEET_REFERENCE_MANIFEST` |
| Notes export | `SUPERCREW_NOTES_REFERENCE_XLSX` | `SUPERCREW_NOTES_REFERENCE_MANIFEST` |

Each reference test is skipped unless both paths are set. Run `npm run test --workspace=@svl/integrations -- src/supercrew/parser.test.ts src/supercrew/notes-parser.test.ts` with the chosen private environment. Tests read the original and manifest without changing either. Review expectations against source controls and selected rows separately; do not regenerate expected values from the parser under test.

Timesheet manifests contain `version: 1`, a `report` object with the exact parsed metadata (all report fields except `entries`), `entryCount`, `jobCount`, `workerCount`, `kindCounts` with `work`, `travel` and `unpaid_break`, and `blankIdentifierCounts` with `employeeId` and `jobCode`. The `report` must include the independently published `reportedTotals`, detail-derived `computedTotals`, `reconciliationControls`, period, generation timestamp, filters, format version and warnings. Monetary totals are integer cents; unavailable independent travel totals are `null`. Use `entries` to supply an array of `{ "index": 0, "expected": { "sourceRow": 13, "kind": "work" } }` checks. Indexes are zero-based; expected fields may also verify privately reviewed identifiers, clocks, capture methods and source quantities.

Notes manifests contain `version: 1`, a `report` object with every report field except `notes` (period, scope, `datesVerified`, format version and warnings), `noteCount`, and `kindCounts` with `daily_candidate`, `entry` and `other`. The `notes` array supplies `{ "index": 0, "expected": { "sourceRow": 2, "kind": "daily_candidate" }, "distinctOwnerAndAuthor": true }` checks. Supply real note text, names, normalized dates and punch details only in the private manifest. The optional owner/author check verifies both fields are present and different. Acquisition period and scope come from this manifest because Notes workbooks do not publish them.

Nonempty reference reports should include representative row checks, including any special capture markers, signed breaks, normalized timestamps or owner/author differences that were independently reviewed. Empty filtered reports may use empty row-check arrays. Counts, classification counts, complete metadata, warnings, all totals and reconciliation controls are compared exactly, rather than stored as observations in public source code.
