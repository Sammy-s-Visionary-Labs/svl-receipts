# Integrated flow acceptance — September 10, 2026

The complete camera → upload → Gemini → manager review → approval → automatic
Housecall export path passed on a physical Pixel 10 Pro XL using synthetic data
and the authorized Test Customer #2 job. This establishes controlled end-to-end
acceptance, not unrestricted production rollout.

## Environment and implementation

- Original full-flow commit: `2e5491c`, branch
  `epic/ra-6-housecall-integration-safe-export`.
- [Current manager test site](https://svl-receipts-ra6-test-svl1.vercel.app) uses hosted
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

## Security patch verification after the camera run

Commit `17c797d` updates Next.js to 16.3.4, sharp to 0.35.4, the matching Next.js
ESLint configuration and js-yaml to 4.3.2. The patched preview is
`https://svl-receipts-cddxnecx3-svl1.vercel.app`; the stable test-site alias above
points to it. Production deployment and production Supabase were not changed.

All 698 unit checks, all 37 browser scenarios in one run, typechecks, lint and the
web production build passed again. An authenticated read-only browser check on
the stable hosted URL verified both existing receipts remain exported, both
provider steps per receipt remain succeeded and both original images load. This
check did not repeat an approval or create new HCP writes. The original physical
camera execution remains evidence from `2e5491c`, not a new post-patch camera run.

The Android release was rebuilt with the stable API URL. The compiled bundle was
checked for that URL, development Supabase, absence of the previous API URL and
production Supabase, and absence of the actual server API credentials. Gradle
initially reused the previous bundle after the environment-file change; deleting
the generated bundle and rebuilding corrected it before installation.

The rebuilt APK was installed successfully at 20:38:53 UTC. The existing worker
session survived the update; the phone's Recent screen displayed both receipts
as Approved with passed readability. The superseded scoped preview deployment
was removed after the stable site and updated phone were verified. This remains
an internal test APK signed with the generated development signing configuration;
production distribution signing has not been established by this run.

The web production dependency audit is clear; the monorepo has sixteen moderate
entries remaining and no critical/high findings. See the
[patch report](ra6-security-patches-2026-09-10.md) for remaining dependency work.

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

A cleanup process-list command exposed server credential values in the private
task tool transcript. They were not committed or bundled in the Android app.
Rotate the affected credentials before production use or sharing the task.
Coordinate the business HCP key rotation with other integrations; the existing
test-customer authorization does not authorize changing business-wide settings.
The deployment helper now supplies credential values through its child process
environment instead of command-line arguments.
