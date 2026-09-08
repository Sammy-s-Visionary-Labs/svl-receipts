# RA-5 hosted development verification

Updated on 2026-09-08. The coordinating task applied the reviewed migration to development project `vrtcbrowjnipbldoioyr`. The read-only hosted preflight then passed all ten schema/API-boundary checks. Its first attempt failed immediately after migration; a targeted retry returned HTTP 200 with an empty category result and the complete preflight passed. Schema-cache propagation is a possible explanation, not a verified root cause. No additional schema change was required.

This preflight did not run hosted receipt processing or make any hosted data mutations. Separately, all seven applied SQL suites passed through the development SQL connector after migration: RA-2, RA-23, RA-25, RA-209, RA-27, RA-4, and RA-5. Each suite rolled back its synthetic test rows. The verified migration version is `20260908200420`; production was untouched. The actual Gemini/Storage/worker pipeline verification ran locally and is recorded in `ra5-database-verification.md`.

Development advisors reported no errors and no warnings on new RA-5 objects. The private evidence table intentionally has RLS enabled with no direct policies: access occurs through checked server operations. Its [no-policy information notice](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy) is expected. New indexes also have unused-index information notices before representative traffic. Existing warnings concern older helper function search paths, signed-in role helper execution, Auth password protection, and the earlier profiles/receipts RLS initialization plans; they were not introduced by this migration.

Use the development configuration at `/Users/kinghill/Documents/svl-receipts/apps/web/.env.local`. Read only its Supabase URL and public/service credentials for the schema preflight, and only its Gemini configuration for the later controlled extraction. Do not copy this file into the repository or print its values. The file does not contain a direct PostgreSQL connection URL, so applied SQL verification needs the authorized development SQL connector or a separately supplied development database connection.

## Route execution budget

The cron worker, upload-confirmation readability kick, and manager re-extraction route each export a literal `maxDuration = 180`. Next.js `after()` shares that route deadline; it does not receive a second budget. Readability has at most 45 seconds and extraction at most 90 seconds within a shared 160-second provider-start budget with a 15-second reserved margin. That budget does not impose a hard deadline on Storage, Sharp, catalog reads, or persistence; the platform still bounds the invocation and expired leases reject late results. Upload confirmation and re-extraction use service-only receipt-scoped claims. Accepted readability continues into extraction immediately, without waiting for other queued receipts. The daily 08:30 UTC cron remains a recovery path. Exhausted pre-inference budgets release the exact stage without changing its due time or consuming an attempt. The manager approval route currently calls an unhandled export kind and performs no provider work; its eventual export budget belongs to RA-6.

Verify the deployed platform honors the generated 180-second function settings. Next.js documents these semantics in the installed `maxDuration.md` and `after.md` API guides. The discovery-based `route-budget.test.ts` fails if any route that runs AI work lacks adequate static configuration.

## Bounded schema preflight

After the reviewed RA-5 migration is applied to the independently verified **development** project, run:

```sh
node scripts/verify-ra5-hosted-schema.mjs \
  --env '/Users/kinghill/Documents/svl-receipts/apps/web/.env.local' \
  --expected-project-ref VERIFIED_DEV_REF
```

Replace `VERIFIED_DEV_REF` only with the confirmed development project reference. The script refuses an endpoint mismatch. It performs seven zero-row schema reads, checks that a nonexistent work lease is rejected, checks anonymous denial of the result RPC, and checks the private evidence API boundary. Requests have ten-second deadlines and at most three concurrent reads. It never applies migrations, enqueues or claims work, invokes Gemini, changes receipts, or calls Housecall. Its output contains pass/fail check names, never raw receipt content or credentials.

## Applied SQL verification

Run all eight suites in `scripts/run-applied-sql.mjs` using an authorized development SQL connection. Each suite creates only namespaced synthetic fixtures and finishes with `ROLLBACK`; do not remove the transaction boundaries. If a direct development connection is available, set `SVL_APPLIED_DATABASE_URL` securely and run `npm run test:applied`. Otherwise execute the SQL suites through the development SQL connector. Do not run any schema reset or seed operation.

The RA-5 suite verifies lease ownership/expiry, extraction generations/replay, missing-field review, tax exclusion, private evidence, category activation, canonical duplicates, correction provenance, sparse source indexes, reordered re-extraction, manual lines, and retention cleanup. Run development security/performance advisors afterward and compare findings with the existing baseline.

## Controlled receipt verification

Use an isolated development test user and explicitly marked synthetic RA-5 images. Record the created receipt IDs so every check targets only those receipts. Keep any live Housecall exporter disabled; this application currently leaves export work queued.

1. Submit one readable two-page synthetic receipt through the upload flow. Verify ordered page evidence, readability completion, one extraction generation, material integer-cent arithmetic, warnings, and `needs_review`. Confirm upload returns before background inference finishes.
2. Re-submit the exact page set. Verify a pending exact duplicate candidate appears; it must not automatically mark the receipt duplicate. Dismiss it and confirm manager review remains usable.
3. Save manager edits and an explicit saved-catalog job assignment. Request re-extraction. Verify a second immutable extraction, preserved manager fields/lines, correct original-line comparisons, and feedback associated with each line's actual source model.
4. Use a synthetic arithmetic-mismatch/missing-field receipt. Verify incomplete rows remain visible and reference tax/total do not alter material costs. Test one category activation, deactivation, and approval denial with a test-only category ID.
5. Confirm a duplicate against a synthetic canonical receipt. Verify the canonical link and manager decision history; verify no outbox intent was created for the duplicate.
6. Open field evidence as manager, then verify worker/anonymous access is denied. Export the sanitized evaluation page and check that raw text, job names, actor IDs, and secret configuration are absent.
7. After recording results, purge only the explicitly recorded synthetic receipt IDs through the retention workflow or delete rollback fixtures inside their original transaction. Verify private evidence, feedback, and reverse duplicate candidates no longer appear. Deactivate test-only configuration through its supported admin control; preserve historical configuration references.

Failures, timeouts, and competing leases are already exercised without provider spending by the applied SQL/unit suites. A real timeout should not be induced across the whole development queue. The two deferred limits remain unchanged: real vendor accuracy and live Housecall synchronization are not established by these synthetic checks.

The forward migration `20260908212303_ra5_scoped_receipt_work.sql` supplies `claim_receipt_work` and `release_receipt_work`. It passed the local rollback suite and is applied locally. Deploy the application only after this forward migration is applied to the same development database; verify `supabase/tests/ra5_scoped_work_applied.sql` there before the positive upload/confirmation smoke.

The coordinating task subsequently applied the additive `20260908212303_ra5_scoped_receipt_work.sql` migration on development and executed `ra5_scoped_work_applied.sql` successfully through the SQL connector. Together with the earlier seven suites, all eight suites have passed on development. The entire eight-suite run also passed locally. No production database was changed.
