# Integrated test flow

The [September 10 acceptance record](ra6-full-flow-acceptance-2026-09-10.md)
includes a successful physical Pixel camera submission through Gemini, manager
approval and automatic Housecall export.

The phone and manager preview use one hosted development Supabase project.
Receipt confirmation schedules Gemini readability and extraction. The manager
reviews the actual result and every uploaded page, then approves the frozen
content for automatic export to the authorized test jobs.

## Automatic test authorization

`HOUSECALL_TEST_SESSION_ID` is server-only and empty by default. An active admin
creates the immutable database session with exact worker/reviewer IDs, verified
job/customer pairs, an expiry of at most 24 hours, and receipt, provider-request,
per-receipt cost and total-cost limits. Only receipts created after the session
qualify. Migrations seed no session, user, job or write permission.

Review, frozen intent, exact-hash write grant and budget reservation commit in
one transaction. A wrong owner/reviewer/job, stale catalog, unsupported quantity,
expiry or exceeded budget rolls back approval. The transport checks the actual
job/customer association before writes. Revocation blocks subsequent dispatch,
including retries; it cannot undo a request already dispatched. Uncertain results
still require durable reconciliation before any resend.

The preview also requires `HOUSECALL_READS_ENABLED=true`,
`HOUSECALL_EXPORT_MODE=approved_test`, and exact customer/job allowlists. Keep
these controls separate from Production. Without a session, ordinary approval
continues to require a separate explicit write grant.

All receipt pages can be inspected without losing draft edits. Quantities with
more than two decimal places remain in the draft but block approval; the app does
not round them or use a quantity-one substitute. Pending export status refreshes
automatically after approval.

## Acceptance procedure

1. Apply development migrations and refresh only the four verified test jobs.
2. Create dedicated test accounts and a bounded session. Keep their credentials,
   bindings and session details in ignored local files.
3. Deploy a development preview with the session controls. Configure the phone
   with the same public Supabase settings and reachable preview API origin.
   Server secrets must never be included in mobile configuration.
4. Sign in as the bound worker, photograph a visibly synthetic receipt or select
   its image, inspect pages and submit. Verify durable upload and actual Gemini
   extraction; seeded extraction JSON is not evidence of this flow.
5. As the bound manager, review all images and fields, resolve duplicate warnings,
   assign the verified jobs and approve. Verify automatic export and exact HCP
   attachment/material readback while preserving existing job content.
6. Exercise physical camera readability and offline recovery. Revoke the session
   when testing finishes and retain the evidence journal.

## Verification boundary

Local unit, browser and rollback-only SQL checks cover atomic authorization,
scope, budget/replay protection, precision, revocation, image navigation and
automatic status refresh. They do not prove physical capture, hosted Gemini,
notification delivery or authentic supplier accuracy; record those separately.

`npm run test:ra6:session-concurrency` additionally runs simultaneous manager
approvals against an explicit loopback database. It observes the second approval
waiting for the session lock, then verifies the exhausted-budget rejection rolls
back the second review. Fixtures are removed afterward; no provider is called.

Controlled end-to-end acceptance is separate from production rollout. Automatic
post-export correction writes, final retention/closure policy, operational
recovery frequency and authentic receipt acceptance remain separate requirements.
