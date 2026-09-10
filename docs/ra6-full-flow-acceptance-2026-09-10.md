# Integrated flow acceptance — September 10, 2026

The complete camera → upload → Gemini → manager review → approval → automatic
Housecall export path passed on a physical Pixel 10 Pro XL using synthetic data
and the authorized Test Customer #2 job. This establishes controlled end-to-end
acceptance, not unrestricted production rollout.

## Environment and implementation

- Application commit: `2e5491c`, branch `epic/ra-6-housecall-integration-safe-export`.
- [Manager preview](https://svl-receipts-z8sev1tei-svl1.vercel.app) uses hosted
  development Supabase. Six forward RA-6 migrations were applied to development;
  production was not changed.
- A standalone Android release APK was built and installed as an update on the
  authorized phone. Its compiled bundle contains the preview and development
  Supabase URLs, no production Supabase URL, and none of the server API secrets.
- The phone and website use dedicated test accounts. Exact identities,
  credentials, session ID and HCP bindings remain in ignored local files.
- Automatic authorization expires September 11 at 18:47 UTC. It permits only the
  four verified test job/customer pairs and bound accounts, with limits of eight
  receipts, forty provider writes, $500 total materials and $200 per receipt.
  At final verification, two receipts, four writes and $101 were reserved/used.

## Actual executions

| Input path | Gemini result and manager review | Verified HCP result |
| --- | --- | --- |
| Normal worker upload API, synthetic stone receipt | Gemini read quantity 0.5, unit cost $42 and total $22.63. Manager corrected the vendor and ambiguous purchase date from the image and selected the test destination. Extraction JSON was not seeded. | One image attachment and one $21 material entry; existing four materials and five attachments preserved. |
| User took and submitted a camera photo of the yellow synthetic receipt displayed on the Mac | Phone preparation and server readability passed. Gemini read the supplier, September 3 date, two yd3 of mulch at $40 and $80 total. Manager corrected ticket character G to 6 against the synthetic receipt, chose Materials, and assigned Test Customer #2. | One camera-image attachment and one $80 material entry; all five preceding materials and six attachments preserved. |

The camera upload was confirmed at 20:15:52 UTC. Gemini completed extraction at
approximately 20:16:01. Manager approval at 20:18:37 was followed by verified HCP
completion at 20:18:39. No separate post-approval grant script or manual export
request was used: the deployed approval endpoint granted its bounded immutable
intent and started export automatically.

The manager screen refreshed to `exported` with two succeeded steps and external
IDs. The phone's Recent screen showed `Approved` and a passed readability check.
HCP readback confirmed quantity 2, unit cost 4,000 cents, the reviewed ticket and
supplier, and the corresponding camera attachment. Each of the four total
provider steps dispatched exactly once. Both receipts' readability, extraction
and export work finished successfully, and retention began after export.

## Validation and retained evidence

- 698 unit checks passed, including six storage-monitor checks.
- All 37 browser scenarios passed across the suite and the corrected two-case
  rerun. Coverage includes multi-page review, preserved draft edits, approval
  messaging and automatic completion refresh.
- All thirteen rollback-only SQL suites passed after a clean migration replay.
  Additional checks cover expired sessions, immutable expiry, scoped rollback,
  exact grants, budget/replay protection and revocation before dispatch.
- A real concurrent-transaction test verified that two manager approvals cannot
  overrun a shared session budget and that the rejected review rolls back.
- Typechecks, repository lint, Next.js production build and Android
  `assembleRelease` passed.

Private evidence under `.local/ra6/` includes `integrated-session.json`,
`integrated-final-invariants.json`, both `*-export-result.json` files, HCP
before/after snapshots, manager screenshots, the actual camera upload, and the
phone's final Approved screen. `test-access.md` contains development logins and
must not be committed or shared. Provider attachment URLs are temporary signed
URLs; comparison uses stable IDs, filenames and object paths.

## Remaining production acceptance

This run used a phone photo of a synthetic document on a screen. It does not close
authentic paper-receipt accuracy, competing-job matching accuracy, the earlier
physical blur false-negative regression, offline/pagination edge cases or Marci's
timed acceptance. The manager explicitly selected destinations; this is not proof
of automatic job-matching accuracy. Push-notification delivery was not asserted.

The previously identified post-export correction execution and formal
abandon/decline retention policies remain open. Vercel's immediate work path
passed, but its documented fallback cron is daily; production recovery frequency,
operations/security checks and backup/restore acceptance remain rollout gates.
None of these should be marked complete from this successful camera-path test.
