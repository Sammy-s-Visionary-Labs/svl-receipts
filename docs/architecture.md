# Receipt App architecture decisions

**Status:** Approved 2026-08-14. These decisions supersede the RA-19 implementation that started retention at upload confirmation (`submitted_at`).

Remediation lives in `supabase/migrations/20260814210000_foundation_hardening.sql`, `supabase/migrations/20260818161945_blocker_remediation.sql`, and `supabase/migrations/20260818173115_trigger_queue_applied_fixes.sql` plus the matching Next.js wiring. Live history used split MCP names (`foundation_hardening` / `p1`–`p7`, `blocker_remediation_p1`–`p6`, `trigger_queue_applied_fixes_p1`–`p3`; Git keeps one file each). Do not rewrite already-applied files. Do not merge to `master` until this branch is reviewed. `supabase db push` can replay the non-idempotent `retention_starts_at` rename against a database that already has `retention_started_at` — apply only new forward migrations.

Related Jira: [RA-2](https://visionary-labs.atlassian.net/browse/RA-2), [RA-11](https://visionary-labs.atlassian.net/browse/RA-11), [RA-15](https://visionary-labs.atlassian.net/browse/RA-15), [RA-18](https://visionary-labs.atlassian.net/browse/RA-18), [RA-19](https://visionary-labs.atlassian.net/browse/RA-19), [RA-66](https://visionary-labs.atlassian.net/browse/RA-66), [RA-206](https://visionary-labs.atlassian.net/browse/RA-206).

Confluence: [Receipt App — foundation decisions (2026-08-14)](https://visionary-labs.atlassian.net/wiki/spaces/VI/pages/8421377/Receipt+App+foundation+decisions+2026-08-14).

## 1. Retention clock (RA-66)

Keep the 365-day policy. The clock does **not** start at upload begin, upload confirmation, or a partial Housecall export.

Set a canonical `retention_started_at` **once**, and only when:

- every Housecall **attachment** and **Job Input** target on the **current** intent has succeeded (not merely any one attachment plus any one job-cost), or
- the receipt is **declined** (`rejected`, `rejected_unreadable`, or `duplicate`). `failed` does not start the clock.

Then `delete_after_at = retention_started_at + 365 days`. Never overwrite `retention_started_at` after it is set.

Partial export (only one of attachment / Job Input succeeded, or only a subset of jobs on a multi-job receipt) must not start the clock. Never-submitted receipts have no start event.

If an approved receipt permanently fails one Housecall step, retention still does not start. A manager-only **export abandoned** action may send the receipt back for correction or formally decline/close it, which then starts retention. Exhausted retries must not start the clock automatically. See §5.

Holds (owner + reason) skip deletion. Purge must not record database success until object removal has succeeded (see §3).

## 2. Processing on Hobby cron

Vercel Hobby remains the pilot host (two crons, each at most daily). That daily job is **recovery**, not the primary trigger.

Intended flow:

1. Upload **confirmation** (object verified) commits the receipt and queues extraction work in one transaction.
2. After that commit, immediately kick an **idempotent** extraction worker.
3. Approval commits the Housecall outbox and queues export work in one transaction, then immediately kicks an **idempotent** export worker.
4. The daily cron recovers missed or stale work, cleans abandoned uploads, enqueues due retention purges, and retries failures.

Do not run external AI or Housecall HTTP inside the database transaction. The durable `work_items` row is the source of truth if the immediate kick fails.

A work row may be marked succeeded only after its handler actually ran. Unimplemented extract/export providers must leave work queued or failed — never complete it as a stub.

## 3. Storage (pilot)

Keep 365-day retention and Supabase Free (1 GB) for the pilot. Extra managed storage is preferred over self-hosting if usage later requires it; decide that from measured data.

Required before relying on Free-tier Storage:

- Client-side resize/compression before upload.
- Storage usage and average-receipt-size monitoring.
- Alerts at **70%**, **85%**, and **95%** of the Storage quota (check **both** `svl-receipts-dev` and `svl-receipts-prod`).
- A storage abstraction so the provider can change later without rewriting receipt lifecycle code.
- **Verified deletion:** the database must not record a purge (or clear `storage_key` / set `content_deleted_at`) until object removal has succeeded.

App-level purge is not backup expiration. Supabase Free has no PITR; see [environments.md](environments.md).

## 4. API-only lifecycle mutations

Workers must not mutate receipt lifecycle through the Supabase Data API.

- Revoke `INSERT`, `UPDATE`, `DELETE`, and `TRUNCATE` from `anon` and `authenticated` on lifecycle tables.
- Revoke execute on privileged mutation RPCs from `PUBLIC`, `anon`, and `authenticated`.
- Allow workers only the RLS-protected reads they need (own profile and own history).
- Route mutations through authenticated Next.js APIs and trusted workers using server-side `service_role`.
- Never expose the service-role key to web or mobile clients.
- Keep RLS enabled as defense in depth, including active-profile checks on remaining owner read policies.
- Integration tests must prove `anon`, workers, and disabled users cannot mutate directly.

## 5. Export abandoned (new policy)

**Owner:** manager (admin may also perform it).

When an approved receipt cannot complete both Housecall steps, a manager may:

- send it back for correction, or
- formally decline/close it.

Decline/close starts retention under §1. Sending it back for correction does not. Dead-lettered export work must not start retention by itself.

## Current implementation

As of `20260818173115_trigger_queue_applied_fixes.sql` and the matching Next.js routes:

- Retention uses `retention_started_at`, set once when the current Housecall intent is fully exported or the receipt is declined (including `duplicate`). Confirm does not start the clock. The column is write-once after it is set.
- Lifecycle mutations go through service-role RPCs from Next.js. `anon` and `authenticated` have SELECT only. Owner reads also require an active profile. Default privileges for future public tables/functions also revoke DML/execute from `anon` / `authenticated` / `PUBLIC`.
- The work runner claims only `purge`, uses a unique lease id per batch, and marks work succeeded only after the handler ran. Extract/export rows stay queued until those providers exist. Confirm and approve kick those kinds after commit; unimplemented kicks no-op and leave the queue as source of truth.
- `claim_work` does not lease purge rows that are held, not yet due, or already purged. A hold conflict defers the job (`defer_work`) without counting toward dead-letter. Clearing the hold requeues that receipt's purge work, including a prior dead-letter from hold retries.
- Purge fences the receipt (`purge_claimed_at`) before Storage delete, then `purge_receipt_content`. A hold during that window is `conflict`. If Storage delete fails and the object is still present, the runner releases the fence. If existence is unknown, the fence stays and the job retries. Absence is `NoSuchKey` (or legacy object-not-found), not a bare 404 or `NoSuchBucket`.
- Confirm requires the object's declared Content-Type to match the session. Missing Content-Type is a mismatch.
- Abandoned-upload cleanup claims the row first (`cleanup_claimed_at`), then removes storage, then `delete_abandoned_upload`. Confirm refuses claimed sessions.
- Approve upserts lines by `sort_index` so `job_candidates` keep their line ids. Job-cost inserts still require `receipt_line_id`. Same-receipt triggers nest `NEW` field access by table so intent/link/attempt inserts do not crash, and they also guard `receipt_lines.extraction_id` and `housecall_outbox.intent_id`.
- Dead-lettered purge work is not auto-revived by `enqueue_due_purges` except the hold-clear path above.
- `append_audit_event` redacts the same secret/image/OCR keys as `@svl/domain`.
- Bearer sign-out uses Auth admin logout and fails the request when that call returns an error. Cookie sign-out still uses the session client.
- Applied permission and execution checks live in `supabase/tests/ra2_applied.sql` (run in one transaction; it rolls back).

After the one-year purge, `housecall_intents.job_cost_lines` currently keeps descriptions, quantities, costs, and job ids. That is the existing Housecall trail; whether that full payload must be redacted is an open product question, not changed here.

Vision/Housecall HTTP remains a later epic. Export-abandoned UI is [RA-206](https://visionary-labs.atlassian.net/browse/RA-206) (policy recorded; not in this pass).
