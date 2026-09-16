# Receipt cleanup and worker access — 2026-09-16

Manager review groups repeated extraction warnings into concise checks with expandable field details. Original extraction evidence and financial validation remain unchanged. Suggestions, material selectors, bulk assignment, export previews, confirmations, retries, history and audit diffs display human job labels and Housecall job numbers. An unavailable catalog entry is labeled unavailable instead of exposing its opaque ID.

`Open original` now navigates to the authenticated receipt image endpoint with `open=1` and the exact page index. The endpoint rechecks current access, signs the current object, and returns a noncached redirect. It does not reuse the expired URL initially used for the thumbnail.

## Housecall material presentation

New frozen material steps carry `material_format_version: 2`. Their description is the approved vendor/invoice-or-ticket/date reference. The part number is `SVL-` plus 24 hexadecimal characters derived from SHA-256 of the original intent/line reference (96 bits). It preserves deterministic reconciliation without displaying receipt, intent or line UUIDs. Attachment identity and original image bytes are unchanged.

Legacy frozen steps retain their exact original request hash and formatting. The original claim implementation is now private. The v2 worker uses a new service-only claim wrapper; the old claim wrapper refuses any intent containing a versioned material step, including its attachments. This makes a database-first deployment safe even if a previous Vercel deployment is still running. Rollback to old code pauses new-format exports; it must not rewrite or recreate their plans.

The user also requested cleanup of the already-posted Matt Acton #1975 materials shown in their screenshot. Three existing material UUIDs were updated after exact matching of their receipt references, names, quantities and unit costs. Readback verified the material count, identities, quantities and $505 total were unchanged. No new materials or attachments were created. Planned and verified `external_attempt` audit events record the presentation change on the receipt; the original frozen approval was preserved.

Official update contract verified 2026-09-16: [Housecall material bulk update](https://docs.housecallpro.com/docs/housecall-public-api/ecc9f7a5d84bc-bulk-update-a-job-s-input-materials). An existing `uuid` updates the material; omitting it creates one.

## Worker access

- `/worker-login`: dedicated worker sign-in, with a first-time signup link.
- `/request-access`: full name, email, optional phone, password and password confirmation.
- `/access-status`: pending, rejected or disabled account guidance.
- `/team`: manager/admin review of pending requests and approved/disabled worker accounts; admins can change approved account roles.
- Android login links to the same signup page. The existing installed build needs updating to expose that link; accounts approved through the website work with the existing app.

Registration calls Supabase Auth's admin creation API on the server. Supabase hashes the password; application tables and audit events never store it. This is an employer-approved onboarding flow, not an email-verification flow: it sends no email, and the approving manager must recognize the person and verify their email address. Reusing an existing email returns the same generic response without changing that account or its password.

The Auth insert trigger creates a pending, disabled worker atomically. Client-supplied role/approval metadata cannot activate access. Existing users retain their current role and disabled state. SQL fixtures can explicitly provision trusted synthetic users using server-only app metadata; manual provisioning through Supabase Auth may require approving the resulting pending profile afterward.

The public request endpoint checks same-origin JSON requests, validates fields and consumes persistent hourly rate limits on hashed email/IP identifiers. Direct public Supabase signup remains disabled. If enabled separately in the future, the trigger still creates pending users.

Role changes use an authenticated, invoker RPC wrapping a private definer implementation. It rechecks database identity, serializes account changes, checks the expected profile version, and writes an audit event in the same transaction. Managers can act only on workers; admins can change approved roles. No one can disable or demote their own account, and an active administrator must remain. Pending/rejected accounts are constrained to disabled workers. Existing JWTs lose application access immediately after disablement because application guards and RLS read the current profile.

## Verification

- Unit tests cover grouped warnings, human labels, fresh image redirects/access denial, compact/legacy request hashing, registration validation, CSRF checks, throttling and duplicate-email handling.
- Real browser tests cover signup on a phone-sized viewport, manager approval/disable, admin role changes, and worker denial of Team access.
- Fresh PostgreSQL migration replay and all applied SQL suites cover existing receipt/export rules, old-worker rejection of compact plans, role restrictions, stale requests, pending/disabled access and access audit events.
- `scripts/verify-worker-access-local.mjs` runs against an explicitly local Supabase stack and verifies actual Auth user creation, password sign-in, pending profiles, approval, immediate disable with an old JWT, re-enable, admin role changes and manager escalation denial. It removes only its own synthetic accounts afterward.
