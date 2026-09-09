# RA-5 implementation and verification — 2026-09-08

RA-5 receipt intelligence is implemented on the verified RA-4 review foundation. The completed behavior covers Gemini extraction, normalization, duplicate review, saved-catalog job suggestions, category configuration, and correction feedback. The user explicitly deferred **real-vendor extraction accuracy** and **live Housecall synchronization/real-job verification**. Those acceptance limits remain open; synthetic results do not close them.

RA-35, RA-37, RA-39 and RA-41 implementation is complete. RA-38 and RA-40 implementation is complete within the controlled test scope, while their real-vendor and live-Housecall acceptance gates remain deferred. RA-36 and its provider-comparison subtasks RA-142, RA-143 and RA-144 are excluded. Gemini Flash is the selected provider; no provider comparison or alternative adapter was added.

The implementation is available in [draft PR #7](https://github.com/Sammy-s-Visionary-Labs/svl-receipts/pull/7) and the [development Preview](https://svl-receipts-web-git-codex-ra-5-receipt-intelligence-svl1.vercel.app). The deployed code at `76a2ee96b397189a587291a9defedb518506b489` passed 36 API checks and two actual upload-to-review checks. Readability immediately continues into extraction for the same receipt. Both synthetic receipts and their Storage images were removed after verification, while approved categories were preserved. No production deployment or production category seeding is claimed.

## Scope and requirements by subtask

| Story | Subtask | Delivered behavior and requirements | Status / remaining gate |
| --- | --- | --- | --- |
| RA-35: AI contracts | RA-139: readability response | Preserves `ReadabilityCheckV1`; unreadable pages remain distinct from accepted documents with extraction warnings and temporary/permanent provider failures. | Complete |
| RA-35 | RA-140: versioned parse result | Strict runtime-validated observations and `ParsedReceiptV1`; nullable missing fields, vendor/date/identifiers, reference totals/tax, all material lines, job hints, confidence and source evidence. Legacy `ExtractionV1` remains supported with stronger validation. | Complete |
| RA-35 | RA-141: provider adapter/errors | Server-only Gemini Flash adapter; model/prompt/schema provenance; normalized timeout, rate-limit, authentication, safety, truncation and malformed-response errors with retry classification. Provider bodies and credentials stay behind the adapter. | Complete |
| RA-37: background extraction | RA-145: worker/timeouts | Processes accepted ordered pages asynchronously; normalizes orientation; validates inference; uses bounded provider deadlines, work leases, bounded retries and visible terminal failures. | Complete |
| RA-37 | RA-146: immutable extraction/evidence | Each work generation has one immutable extraction result. Reprocessing appends a generation; raw OCR and original observations live in private evidence storage. Saved edits and original line provenance survive reprocessing. | Complete |
| RA-37 | RA-147: material projection/review | Persists normalized extraction, valid material-line projections and suggestions atomically, then moves the receipt to `needs_review`. Incomplete lines remain available for manager correction; missing fields do not become unreadable-image failures. | Complete |
| RA-38: normalization/arithmetic | RA-148: values and units | Explicit USD conventions, integer cents, positive quantities to three decimals, UOM aliases, valid calendar dates and ambiguity warnings. Unsupported currency/returns and malformed values are not silently converted. | Implementation complete |
| RA-38 | RA-149: extended costs/warnings | Application code computes quantity × unit cost with deterministic half-up rounding. Printed amounts remain evidence. Tax/payment/summary values do not become material costs; line/subtotal/receipt differences produce warnings. | Complete |
| RA-38 | RA-150: vendor regressions | Synthetic Select, Sandman, Klumm, Menards, Lowe's, Home Depot and Perrysburg Pipe formats cover numeric, date, unit, arithmetic and continuation-page behavior. | Synthetic implementation/verification complete; authentic vendor-format accuracy deferred |
| RA-39: duplicate candidates | RA-151: exact image hashes | Compares the complete confirmed page set and records exact candidates before provider extraction; one shared page alone is insufficient. | Complete |
| RA-39 | RA-152: near-duplicate scoring | Configurable vendor/date/amount/identifier evidence scoring; normalized punctuation/Unicode prefilter; identifier conflicts prevent similar separate purchases from becoming candidates. Reasons accompany scores. | Complete |
| RA-39 | RA-153: canonical links/decisions | Manager confirmation alone establishes a canonical duplicate and prevents export intents. Dismissals remain in history without blocking approval. Reprocessing preserves decisions; purge removes forward/reverse links. | Complete |
| RA-40: job suggestions | RA-154: references/customer names | Matches printed/handwritten job and PO references plus exact/partial customer names against existing immutable catalog IDs; exact references outrank names and retain their evidence. | Implementation and controlled-catalog verification complete; authentic Select/Klumm matching and real-job verification deferred |
| RA-40 | RA-155: supporting context | Adds schedule, assignment, active status, uploader history, vendor history and optional GPS. Distance requires valid coordinates/address and acceptable capture accuracy. Missing context does not invent evidence or block ranking. | Implementation complete; live synchronized context/Housecall verification deferred |
| RA-40 | RA-156: candidates/reasons | Returns a leading candidate and up to five candidates per receipt or hinted line, with plain-language reasons. Exact line references take precedence for that line; manager choices remain authoritative. | Implementation and controlled-catalog verification complete; live Housecall ranking verification deferred |
| RA-41: categories/feedback | RA-157: category configuration/suggestions | Admin-controlled stable category IDs, keywords, activation and configuration versions; ambiguous/unknown categories require review, and inactive categories remain readable historically. Approval requires an active category. | Complete; user-approved Materials, Fuel, Dump and Misc configured on development |
| RA-41 | RA-158: accepted/overridden suggestions | Immutable original/final header and line values, job choices, actor and source model/prompt/scoring versions. Original line IDs prevent false feedback after reordered re-extraction; manual additions receive no fabricated model origin. | Complete |
| RA-41 | RA-159: sanitized evaluation | Admin-only allowlisted exports preserve numeric values and version metadata while pseudonymizing text/identities. Review identity, decision and version distinguish interim drafts from final approvals. Feedback never silently retrains or retunes production. | Complete |

The detailed extraction contract is in [receipt-extraction-contract.md](receipt-extraction-contract.md). Duplicate, ranking, category, evaluation and threshold behavior is documented in [receipt-intelligence.md](receipt-intelligence.md). The existing review/approval requirements remain in [manager-review.md](manager-review.md).

## Fixture pack and actual Gemini verification

The [fixture pack](../fixtures/ra5/README.md) contains **13 PNG files**: 11 document cases across 12 generated images, plus one byte-identical copy for exact-hash verification. Images are explicitly marked synthetic. Original Downloads receipts were not modified. The [manifest](../fixtures/ra5/manifest.json) defines expected fields/warnings, and the [controlled catalog](../fixtures/ra5/catalog.json) supplies fictional jobs/categories. These IDs must never be sent to Housecall.

Coverage includes decimal tonnage, handwriting and conflicting hints, multiple jobs by line, deliberately wrong printed totals, ambiguous dates, missing costs, a two-page continuation, positive exact/near duplicates, a separate legitimate purchase, a picking-list negative control, and fuel categorization/rounding.

All **11 document cases passed actual Gemini inference** using `gemini-3.5-flash-lite`, prompt `ra5-receipt-v1.0`, and schema version 1. The retained [Gemini results](../fixtures/ra5/evaluation/gemini-results.json) record image hashes, requested/returned model, latency, usage, normalized synthetic predictions and assertions. Credentials, full raw provider output and full OCR text are excluded. Missing field evidence on a multipage result produced the expected review warning rather than invented confidence.

Live verification uncovered a provider compatibility issue: large nested `maxItems` constraints caused HTTP 400 `INVALID_ARGUMENT`. Removing only those provider-schema maxima resolved the request. Domain caps of 100 lines, 100 job hints and 1,200 evidence entries remain enforced and regression-tested. Strict field/type/date/amount validation was not weakened.

## Executed verification

Counts below describe separate checks and must not be added into a single unique-test count; several checks overlap.

| Verification layer | Result | What it establishes |
| --- | --- | --- |
| Base `npm test` | **445 tests passed** | Storage, mobile, web, domain and integration regression behavior, including preserved RA-4 flows |
| Workspace TypeScript checks | Passed | Cross-package and application type compatibility |
| Repository lint/format checks | Passed | Repository coding/format requirements |
| Next.js production build | Passed | Production application compilation and generated route configuration |
| Playwright browser suite | **32 scenarios passed**; **3 affected scenarios passed again after fixture correction** | Manager interactions, permissions, review preservation and intelligence UI; the three reruns are not three additional unique scenarios |
| Offline RA-5 fixture checks | **4 checks passed** | Retained results match current image bytes; controlled job/category ranking and duplicate positive/negative controls behave correctly without additional provider calls |
| Actual Gemini fixture evaluation | **11 cases passed** | Real adapter/provider extraction on this labeled synthetic pack |
| Actual local Storage → readability → extraction worker → database smoke | **2 cases passed; cleanup verified** | Select multijob and Lowe's incomplete-field receipts reached `needs_review`, retained correct arithmetic/lines/job candidates/private evidence, and created no export intents |
| Applied SQL suites, local | **8 suites passed** | RA-2, RA-23, RA-25, RA-209, RA-27, RA-4, RA-5 and receipt-scoped work transaction/authorization/retention regressions |
| Applied SQL suites, hosted development | **8 suites passed** | Initial seven suites after the main migration, then the scoped-work suite after the additive follow-up; namespaced synthetic fixtures with rollback |
| Hosted read-only schema/API preflight | **10 checks passed** | New schema availability, invalid-lease refusal, anonymous RPC denial and private evidence boundary |
| Deployed Preview API checks | **36 checks passed** | Anonymous, disabled, worker, manager and admin authorization, invalid input/missing-resource guards, four active approved categories, and empty evaluation response shape; [sanitized report](ra5-preview-verification.json) |
| Actual Preview upload → readability → extraction → manager review | **2 cases passed; Storage/database cleanup verified** | Select reached `needs_review` in 22 seconds; Lowe's in 18 seconds with its incomplete line and warnings retained. Actual Gemini, private evidence permissions and integer cents verified; [sanitized report](ra5-preview-pipeline-results.json) |
| Supabase advisors | **No errors and no RA-5 warnings** | No new warning/error findings on RA-5 objects; informational findings and existing baseline warnings are described below |

The local end-to-end smoke used actual private Storage, actual Gemini readability/extraction, scoped work leases and committed database results. Both cases reached `needs_review`. The incomplete Lowe's receipt kept two extracted lines while projecting only its one valid numeric material line. No Housecall requests occurred, and test-owned receipts, user, catalog/category configuration and restricted evidence were cleaned up. See [database/worker verification](ra5-database-verification.md) and the [sanitized pipeline report](ra5-local-pipeline-results.json).

The SQL checks exercise stolen/expired leases, evidence-free completion refusal, generation replay, latest-result ordering, incomplete lines, cents/tax rules, private evidence access, category activation, canonical duplicates, Unicode/punctuation matching, sparse source indexes, reordered re-extraction, manual additions, correction provenance, terminal failures and retention cleanup. SQL fixtures roll back; they do not approve real receipts or reset existing data. CI also runs the retained synthetic-fixture check without provider calls, so mismatched image evidence or changed ranking behavior cannot silently bypass it.

Browser fixtures and API/SQL tests establish different boundaries: browser interception supports deterministic UI assertions, actual route tests check server behavior, and applied SQL runs real transactions/permissions. The actual Gemini and local pipeline checks supply separate provider/worker evidence. None establishes either deferred real-vendor or live-Housecall acceptance claim.

## Development rollout state

The reviewed canonical migration [20260908200420_ra5_receipt_intelligence.sql](../supabase/migrations/20260908200420_ra5_receipt_intelligence.sql) is applied to development project **`vrtcbrowjnipbldoioyr`**. The additive follow-up migration `20260908212303_ra5_scoped_receipt_work.sql` is also applied. All eight applied suites passed locally; the original seven plus the follow-up scoped-work suite passed on development. The hosted read-only preflight passed ten checks. The original deployment passed all CI jobs; the follow-up build, 445 tests, typechecks and lint also pass locally. This consolidated record includes the subsequently completed hosted SQL verification; the [hosted runbook](ra5-hosted-dev-verification.md) also describes the preflight and remaining application verification procedure.

Advisors reported no errors or RA-5 warnings. Informational findings include intentionally policy-free private evidence storage, which is unavailable to anonymous/authenticated Data API callers and accessed through actor-checked server operations, and unused indexes on new objects. Existing warnings concern older helper functions, Auth configuration, and earlier profiles/receipts RLS plans; they were not introduced by RA-5.

All routes that perform AI work statically declare a 180-second execution budget. This leaves preparation and persistence time around the 90-second provider deadline within the 300-second work lease. A route-budget regression verifies the static declarations. The actual Preview confirms successful background chaining and manager evidence access on both fixtures. The 180-second route setting is statically checked; these successful 18/22-second runs do not independently measure the platform's maximum-duration enforcement. The shared 160-second provider-start budget reserves time for cleanup/persistence and releases unstarted scoped work when time is insufficient; it is not a hard end-to-end I/O timeout.

## Remaining gates

1. **Authentic vendor accuracy — explicitly deferred.** Obtain and label representative real receipts for Select, Sandman, Klumm, Menards, Lowe's, Home Depot and Perrysburg Pipe. Include verified fields, material lines, warnings and real Select/Klumm examples. Run actual Gemini against those originals and assess the expected results. Synthetic layouts cannot close RA-150's real-vendor acceptance or related authentic-document matching claims.
2. **Live Housecall data and assignments — explicitly deferred.** Complete or provide the RA-6 Housecall client/job synchronization dependencies (RA-42/RA-43), populate the saved catalog with real immutable IDs and synchronized context, and verify known assignments against competing jobs. This closes the live portion of RA-40/RA-154–RA-156. RA-5 itself makes no Housecall API calls; attachments/material-cost writes remain RA-6 work.

The user-approved Materials, Fuel, Dump and Misc categories are configured on development and verified active at version 1. See [configuration evidence](ra5-approved-categories.json). Existing fixture-tested keywords were retained; Misc has no fallback keywords. Production remains outside this development rollout. Preview/PR preparation is complete. RA-35, RA-37, RA-39 and RA-41 are completed; RA-38/RA-150 and RA-40/RA-154–RA-156 remain open only for the two deferred acceptance limits. RA-148 and RA-149 are complete.

Prompt, category-keyword or scoring-threshold changes require the relevant extraction, duplicate, job-ranking and manager regressions before promotion. Per-page pseudonyms in sanitized evaluation exports cannot be joined across pages/downloads; use the documented final-decision filters and avoid unsupported whole-receipt grouping metrics. Feedback does not change production behavior automatically.

## Reproduce relevant checks

```sh
npm test
npm run typecheck
npm run lint
npm run build:web
npm run test:e2e
npm run test:ra5:fixtures
```

Run the build and browser development server sequentially because they share Next.js artifacts. For opt-in provider evaluation, set `RA5_GEMINI_ENV_FILE` to an existing authorized server environment file and run `npm run test:ra5:gemini`; optionally set `RA5_FIXTURE_IDS` to a comma-separated subset. This consumes Gemini usage and is excluded from ordinary tests. Never copy credentials into this repository or output them in reports.

For applied SQL, set `SVL_APPLIED_DATABASE_URL` securely to the intended authorized local/development database and run `npm run test:applied`, or use the authorized development SQL connector with the same rollback-only suites. See the [database verification](ra5-database-verification.md) and [hosted runbook](ra5-hosted-dev-verification.md) for the bounded local pipeline smoke, project-ref guard and read-only hosted preflight. Do not reset an existing database to repeat acceptance checks.
