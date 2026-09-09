# RA-4 development acceptance — 2026-09-08

Technical verification is complete for the independent RA-4 scope. Marci's hands-on acceptance and approximately one-minute review target remain pending, as requested by the product owner. RA-5 extraction and RA-6 live export/reconciliation remain separate integration dependencies.

## Environment and scope

- Application commit: `6d42163a89c8712892ae4abec0a3433c6144f87d` on `epic/ra-4-manager-review-audit`.
- Hosted database: `svl-receipts-dev`, project `vrtcbrowjnipbldoioyr`; all 21 repository migrations confirmed applied.
- Preview: https://svl-receipts-f3xtw36gx-svl1.vercel.app (GitHub deployment `6315475315`, successful).
- The local app at `http://localhost:3000` uses the same development database.
- Persistent test fixtures are the eight `RA4 demo N.jpg` receipts and the two `ra4-demo-job-*` jobs. No production database or live Housecall write was involved.

## Executed verification

- **362 automated tests passed**, including a repeat under Node 24.20.0: storage 6, mobile 111, web 98, domain 139, integrations 8.
- All workspace type checks and Biome checks passed; production build passed under Node 24.
- **30 Playwright scenarios passed** under Node 24, including bulk assignment confirmation, failed-save preservation, failed-step retry, administrator correction impact, desktop/narrow layouts, keyboard image pan and server role guards. This remains fixture-based browser evidence.
- All six rollback-only SQL suites passed against hosted development: RA-2, RA-23, RA-25, RA-209, RA-27 and RA-4. The connected database tool executed the exact SQL files; RA-209 explicitly opted into the documented hosted monitor LOGIN configuration. Database permissions were not altered to make tests pass.
- Real Chrome manager session against localhost/hosted dev verified image zoom/rotation/refresh preserving unsaved notes, draft persistence, two-tab stale save rejection preserving the losing tab's edits, required category/jobs, exact $1.01 + $6.50 = $7.51 material calculation, separate assignments to identically named jobs, and tax acknowledgment before approval.
- Persistent approval produced one intent, one outbox entry and queued export work. Clarification stayed `needs_review`; decline and duplicate created no export intents and started retention. History displayed all three finalized outcomes and their audit trail. Original extraction stayed unchanged.
- Real hosted email/password sessions for manager, administrator, worker and disabled manager were checked through both localhost and Preview APIs. Manager/admin access succeeded, workers received 403 on manager/admin endpoints, disabled accounts received 401 `account_inactive`, and manager correction submission was denied. The worker successfully read its own recorded clarification.
- Authenticated Preview API smoke passed: private Storage signed image download, draft save/read-back, immutable original evidence, stale version 409, clarification persistence without export, read-only approved review with four targets, and an administrator correction proposal returning 202/pending with audit evidence and no change to the approved snapshot. These are deployed API checks, not a claim of a separate manual browser walkthrough of Preview.

## Test portability fixes

Two pre-existing assumptions surfaced when the applied suites ran against populated hosted development:

1. RA-27 counted unrelated receipts in broad filters. Count assertions now use the fixture owner's submitter filter while retaining server-side filter/pagination assertions.
2. RA-209 assumed the storage-monitor role always had NOLOGIN, although the operational runbook deliberately enables LOGIN for hosted monitoring. The SQL runner now supports `SVL_APPLIED_ALLOW_MONITOR_LOGIN=true`. The default remains strict NOLOGIN; superuser, BYPASSRLS, role/database creation and direct row-read restrictions remain enforced.

To repeat hosted SQL checks, put the development PostgreSQL connection URI privately in `apps/web/.env.local` as `SVL_APPLIED_DATABASE_URL`, then run:

```sh
SVL_APPLIED_ALLOW_MONITOR_LOGIN=true node --env-file=apps/web/.env.local scripts/run-applied-sql.mjs
```

Only enable that option for an environment where monitor LOGIN is intentional. A clean local migration replay should omit it. Credentials, tokens and signed image URLs are not included in this report.

## Persistent fixture outcomes

| Fixture | Receipt ID | Final test state |
| --- | --- | --- |
| Demo 1 | `bc2f4f4c-b1cf-404e-af9c-06a009a25d51` | Clarification recorded; needs review |
| Demo 2 | `bb4ba808-d5fd-49e5-af84-08522868dd97` | Declined; no export intent |
| Demo 3 | `e797eb7e-06c6-478b-aa35-c19f4c30d16f` | Approved; queued export; administrator correction proposal pending |
| Demo 4 | `5a6ea9af-3ba3-4bc4-8a06-2e017c71aff5` | Duplicate linked to Demo 3; no export intent |
| Demo 5 | `67d79846-0ed1-4558-9fde-72c619db90ab` | Preview draft and clarification recorded; needs review |
| Demos 6–8 | Unchanged | Available for Marci's acceptance |

These synthetic job IDs are not Housecall jobs. Exclude these fixtures and their pending commands from any future live RA-6 runner; remove them through a reviewed cleanup before enabling live exports in this environment.

## Remaining acceptance

- Marci's single-job timing, multi-job review and usability feedback: **pending by explicit user direction**.
- Live extraction/suggestions: RA-5.
- Housecall synchronization, writes, uncertain-write reconciliation and execution of pending recovery commands: RA-6.
- Production rollout is not part of this development acceptance.

RA-4 should remain **In Review** while human acceptance is pending. The technical results above allow development to proceed to RA-5 without claiming live Housecall completion.
