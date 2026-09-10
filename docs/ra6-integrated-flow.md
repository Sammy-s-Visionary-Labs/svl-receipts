# Integrated receipt flow

## Normal operation

The September 10 all-job rollout supersedes the four-customer test boundary on
the current manager/phone deployment. `HOUSECALL_ACCESS_MODE=all_jobs` enables
account-wide job reads; `HOUSECALL_EXPORT_MODE=manager_approved` makes an active
database manager/admin receipt approval the write authorization. Login, receipt
review, and approval use the active `profiles.role`, not named users or reviewer
grants. Workers cannot review or approve.

`manager_review_with_export` saves the review, freezes its images/lines/jobs,
records exact job/customer bindings, and creates a write authorization in one
transaction. Approval does not expire with a testing session. Each dispatch
rechecks the approving account role and gets a short one-use transport permit;
immutable plans, attempt bounds, uncertain-result reconciliation, and current
provider availability/customer checks remain enforced. No previously queued
intent receives authorization merely because deployment configuration changes.

The search includes older jobs by default. Managers can use **Refresh Housecall
jobs** for new jobs; this synchronizes the saved catalog with GET requests only
and preserves unsaved receipt edits. Canceled/deleted/locked and stale jobs still
require resolution before export. Quantities beyond two decimals remain blocked.

Set `HOUSECALL_EXPORT_MODE=disabled` to stop new writes without changing roles.
The all-job rollout retains the current hosted development database so existing
phone submissions and manager accounts stay together. It is not a migration to
the separate production database. Production launch still requires the open
operational/security and genuine receipt acceptance work in the acceptance record.

## All-job rollout verification — September 10

- Full Housecall job sync: 990 scanned, 843 available; 10 GETs and zero writes.
- 315 web and 104 integration unit tests, 38 browser tests, and all 14 rollback-only
  SQL suites passed. Typechecking, lint, and the production build passed.
- A hosted rollback-only transaction used the existing manager profile and a job
  outside the former four-job list. It produced the correct frozen authorization,
  then rolled back the synthetic receipt, review, intent and grant before any
  worker could observe them. No Housecall request or retained approval resulted.
- Security advisors reported no errors or new-function warnings. Existing
  unrelated advisories remain tracked separately.

## Historical bounded test setup

The [September 10 acceptance record](ra6-full-flow-acceptance-2026-09-10.md)
includes a successful physical Pixel camera submission through Gemini, manager
approval and automatic Housecall export.

The phone and manager preview use one hosted development Supabase project.

An existing active manager may be admitted to a running test session through the
service-only `authorize_housecall_test_reviewer` operation. Only the session's
original active administrator can authorize this addition. The append-only grant
records the reviewer, authorizer, reason and timestamp; the original session row,
owner restrictions, four destination bindings, expiry and accumulated budgets
remain unchanged. Added reviewers share the existing limits and lose access when
disabled or when the session expires or is revoked. No browser role can create or
edit these grants. A missing reviewer permission has its own error message so it
is not misreported as an expired session.
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
