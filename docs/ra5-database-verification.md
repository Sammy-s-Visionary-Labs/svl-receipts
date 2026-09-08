# RA-5 database and worker verification

Verified on 2026-09-08 against the existing **local** Supabase PostgreSQL 17 database on port 54322. No production or hosted database was modified, no existing local receipt data was reset, and no Housecall requests were made.

The CLI-created migration `20260908200420_ra5_receipt_intelligence.sql` extends the verified RA-4 schema. It is applied locally. During implementation, function refinements were tested directly and folded into this uncommitted migration; the final file represents the final verified schema.

## Implemented behavior

- Extraction is a handled queue kind. Work generations, active leases, immutable result rows, and completion evidence make retry/replay idempotent. A manager re-extraction request increments the generation and preserves prior review snapshots and line assignments.
- One to five confirmed pages are processed in order. Sharp applies orientation and bounds decoded image size before Gemini inference. The provider attempt uses a 90-second timeout inside the five-minute lease; existing bounded queue backoff and dead-letter behavior remain authoritative.
- Exact full-page checksum candidates are available before extraction. Vendor/date/amount/identifier candidates are scored after extraction. Only manager confirmation changes duplicate status or blocks export; dismissal history remains durable.
- The extraction result, material-line projection, job/category suggestions, and near duplicate candidates are recorded atomically. Incomplete parsed lines remain in the extraction for manager review. Only valid numeric lines enter `receipt_lines`; tax/reference totals are not allocated into material costs.
- Raw OCR, verbatim field evidence, and original provider observations live in `receipt_private.extraction_evidence`, outside the Data API. Staff can request field snippets through an actor-checked server route. Retention purge removes this evidence, feedback, and duplicate links.
- The category catalog starts empty. Admins configure valid active IDs; approval requires an active category. Historical categories remain readable after deactivation. The catalog is capped at 500 configurations.
- Review feedback captures suggested/final values and model, prompt, and scoring provenance. Line feedback resolves the immutable source extraction from its line ID, so reordered later generations do not invent corrections against the wrong model output. Manual additions carry no invented model origin.
- Job matching consumes the saved catalog and bounded uploader history. It never calls Housecall.

## Checks completed

- `npm run test:applied` passed all seven rollback-only suites: RA-2, RA-23, RA-25, RA-209, RA-27, RA-4, and RA-5.
- New SQL assertions cover lease theft/expiry, evidence-free completion refusal, replay, deterministic latest generations, incomplete line preservation, integer-cent cost projection, raw evidence restrictions, manager correction provenance, sparse source indexes, reprocessing with reordered lines, manual additions, inactive categories, duplicate decisions, Unicode/punctuation vendor matching, permanent provider failure visibility, and retention purge.
- Five extraction worker tests passed: EXIF orientation/metadata removal, generation replay, invalid page sets, ordered pages/provenance, and no result persistence after provider timeout.
- Web TypeScript check passed. Targeted queue/domain regression tests passed (15 tests).
- Supabase local advisors reported **zero errors and no warnings on new RA-5 objects**. Existing warnings concern older helper function search paths and the earlier profiles/receipts RLS initialization plans; these were not introduced by RA-5.

Real-vendor extraction accuracy and live Housecall synchronization remain the two explicitly deferred verification limits. Local fixture checks do not establish either result.

## Real Gemini through the local pipeline

The explicit smoke in `scripts/ra5-local-pipeline-smoke.test.ts` passed both `select-multijob` and `lowes-ambiguous-missing` using **gemini-3.5-flash-lite** and the actual worker. It uploaded synthetic images to local private Storage, ran Gemini readability, leased only its own extraction rows, processed through `runExtraction`, and inspected committed database results. The two cases reached `needs_review`; per-line job matches, integer-cent arithmetic, missing-field preservation, and private evidence passed. No export intent or Housecall request occurred. Retention purge and scoped removal of the test-owned user, catalog, and category rows completed successfully.

The sanitized run report is `docs/ra5-local-pipeline-results.json`. To repeat this bounded smoke explicitly:

```sh
SVL_RUN_RA5_LOCAL_PIPELINE=true \
SVL_RA5_GEMINI_ENV_FILE='/Users/kinghill/Documents/svl-receipts/apps/web/.env.local' \
./node_modules/.bin/vitest run --config scripts/ra5-local-pipeline.vitest.ts
```

The harness obtains local Supabase connection values in-process and rejects nonlocal hosts. It imports only Gemini configuration from the supplied application environment and never copies or prints its secrets. This command consumes Gemini usage; it is deliberately excluded from ordinary unit tests.

The route budget regression also passes: all routes that run extraction/readability work have a statically exported 180-second `maxDuration`, leaving preparation and persistence time around the 90-second provider timeout inside the 300-second lease.
