# Manager Review & Audit (RA-4)

Branch: `epic/ra-4-manager-review-audit`. RA-27 supplies the queue; this increment covers RA-28–RA-34 and RA-118–RA-138.

## Implemented manager flow

Open a queue row, then **Open full receipt review**. The receipt image and review form share a desktop workspace with independent scrolling and persistent actions. Smaller screens stack the panels. Image zoom, pointer/keyboard pan, rotation, fit width, original access and retry preserve unsaved fields. GPS is available only after manager authorization. Inspection uses page one; multi-image manager navigation remains outside RA-119's current scope.

Vendor, date and category are required for approval. Invoice/ticket numbers, notes and receipt reference total are editable. Original extraction evidence remains immutable and separately inspectable. A snapshot save records actor, review version, base version, extraction ID and changed fields. The API rejects stale review or extraction versions with HTTP 409. Earlier sparse reviews and approved material rows are preserved when reopening legacy receipts.

Materials support add/delete, description, positive quantity (three decimal places), UOM, nonnegative unit cost (two decimal places), and immutable Housecall job ID. Extended costs use integer arithmetic and half-up rounding to cents, including `1.005 × $1.00 = $1.01`. SQL checks the same rules when committing. Individual and aggregate costs are bounded to a signed 32-bit cents value. Reference total and tax never allocate amounts to job costs. Invoices above the 100-line limit return an explicit error rather than silently dropping rows.

The picker combines stored suggestions with a bounded job catalog search. Active and older/unscheduled jobs show available customer, job number, schedule, status and technician context. Duplicate labels retain separate IDs. Applying a suggestion to all lines requires confirmation before replacing a different assignment. Snapshots retain suggestion IDs alongside the selected job, so acceptance and override can be distinguished. Every approved line must resolve to a known catalog job or a stored candidate for that receipt. Overhead/no-job stays blocked.

Save for later and clarification remain `needs_review` and create no export intent. Clarification stores a bounded worker-facing reason, shown in the worker receipt detail. The existing worker chip remains **In review**, preserving the locked RA-3 vocabulary. There is no new push/email/Slack delivery; the manager contacts the worker through the agreed channel. Decline and duplicate require reasons; duplicate also requires a different, valid canonical receipt. Both are audited and start retention. Approval confirms the exact lines/jobs/cost and tax exclusion, and commits the review, lines, immutable intent, outbox and queued work atomically. A post-response kick attempts the export handler; the durable queue remains authoritative when it is unavailable. Repeat/stale approval cannot create another intent.

History spans approved, exporting, exported, declined, duplicate, partial and failed receipts. Search includes vendor, receipt/reference, selected job ID/number/customer/label, exact external IDs, decision and export state. History rows include final assigned jobs. Receipt reopen is read-only by default. The bounded timeline is chronological with timestamp/UUID pagination and includes extraction, review changes, decisions, export attempts, retries and correction proposals. Raw provider bodies, OCR and signed storage URLs are excluded from timeline data.

## Recovery and integration boundaries

Attachment and job-cost targets have separate status cards, timestamps and external IDs. A successful link or attempt is authoritative, even if conflicting failure evidence arrives later. A retry records one exact failed attempt in `manager_recovery_commands`; duplicate requests return the existing pending command. The transaction rejects current-intent mismatches, stale attempts and already-succeeded targets. Attempt history remains append-only.

Post-export correction proposals are administrator-only. The confirmation displays old/new values and states the planned action: external reconciliation before any replacement or reversal. The proposal captures its source intent and original/desired snapshots, records its reason and audit event, and never edits the posted snapshot or sends a replacement silently. Conflicting active recovery and leased export work prevent a correction request.

**RA-6 dependencies are still required for live operation:**

- Job synchronization must populate `manager_job_catalog` with Housecall IDs and normalized context. RA-4 does not invent jobs when the catalog is empty; stored receipt candidates remain usable.
- The existing `export` work handler is intentionally unimplemented until RA-6. RA-4 approvals create genuine durable pending work; they do not simulate successful Housecall writes.
- RA-48's recovery/reconciliation handler must consume pending `manager_recovery_commands`. A retry must re-read the current target, reconcile uncertain external writes, skip successes and retain attempts. A correction must resolve the specific old/new external impact before recording completion. RA-4 records and displays these requests; it does not implement provider HTTP or reversal semantics.
- Live receipt extraction remains RA-5. Manual review can start from normalized extraction evidence or an empty draft when a receipt is already in `needs_review`.

These are integration dependencies, not passing live-export evidence. No live Housecall job or production database was changed during verification.

## API and database

- `GET /api/manager/receipts/:id`: authenticated detail and first timeline page.
- `POST /api/manager/receipts/:id/review`: `{decision, version, extractionId, draft, reason?, canonicalReceiptId?, taxExcluded?}`.
- `POST /api/receipts/:id/approve`: compatibility URL using the same versioned approval contract; no legacy unconstrained body.
- `GET /api/manager/jobs?search=...&scope=active|all`: literal bounded search, maximum 50 jobs.
- `GET /api/manager/receipts/:id/events?cursor=...`: maximum 50 chronological events.
- `POST /api/manager/receipts/:id/recovery`: exact retry target or explicit administrator correction proposal; HTTP 202 means queued, never externally completed.

Apply `20260907193142_ra4_manager_review_audit.sql` after RA-27, before deploying this web/mobile increment. Hosted migrations have not been applied by this work. Database changes are forward-only. New reads run with authenticated RLS; mutation functions are `SECURITY INVOKER`, service-role-only, and validate the active actor. New tables explicitly grant access and enable RLS. Purge removes new clarification/recovery content and hides receipt detail, image access and recovery history while preserving the existing minimal audit/export trail policy.

## Verification

See [manager-review-verification.md](manager-review-verification.md) for the executed tests and their limits.
