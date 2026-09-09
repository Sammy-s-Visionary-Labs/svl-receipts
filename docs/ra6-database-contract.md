# RA-6 database worker contract

No live Housecall writes are authorized by this migration or by a manager receipt approval. All grant rows start absent. The working agreement in `AGENTS.md` requires explicit user approval for the exact live destinations and payload scope, including test jobs, retries, and cleanup.

## Frozen plans

Versioned manager approval atomically records its immutable `housecall_intents` snapshot, creates the current outbox/work row, and freezes confirmed receipt pages in `approved_images`:

```ts
{ page_id: string; page_index: number; storage_key: string;
  content_type: "image/jpeg" | "image/png" | "image/webp";
  checksum: string; byte_size: number }[]
```

`housecall_intents.approved_reference` freezes the approved supplier, preferred invoice number (ticket number fallback), and purchase date, for example `SYNTHETIC RA6 TEST #RA6-TEST-1 2026-09-09`. It is included in the intent hash and every step envelope so provider material descriptions can use an approved, traceable reference while preserving the original line description.

Each distinct destination receives one `housecall_export_steps` attachment per image, plus one cost step per assigned receipt line. An attachment payload contains `{intent_id,receipt_id,payload_version,housecall_job_id,approved_reference,step:"attachment",image}`. A cost payload contains the same envelope with `step:"job_cost"` and `line:{receipt_line_id,job_id,description,qty,unit_cost_cents,extended_cost_cents}`. Reference totals/tax are not added to costs. Quantities remain decimal; extended cents use the approval's rounded quantity × unit cost arithmetic.

`housecall_intents.payload_hash` and each step's `payload_hash` use PostgreSQL SHA-256 of canonical JSONB text. Treat these as opaque database fingerprints, not hashes of arbitrary JavaScript JSON serialization. The transport separately fingerprints its precise prepared HTTP request. The worker must derive that request only from the frozen step and verified image bytes; matching a customer name is insufficient.

Historical intents without a versioned manager approval have no RA-6 hash and cannot enter this worker. Missing/incomplete confirmed image manifests leave an inspectable plan but block claiming and approval. A correction stays a separate manager proposal; inserting another intent for an already exported/planned receipt raises `correction_requires_reconciliation`. Corrections are rejected while any RA-6 step is in flight or awaiting reconciliation, sharing the same receipt lock as claim/dispatch; expiry does not remove this fence. The current implementation intentionally does not execute additive corrections against old costs.

## Service-only RPCs

All mutation RPCs below revoke `PUBLIC`, `anon`, and `authenticated` execution. Only the backend service role can call them. The approval and retry RPCs also validate the supplied active actor against persisted roles. Clients receive no table write privileges on plans, locks, or live approvals; the service role cannot directly insert/update approval rows either.

- `list_ready_housecall_exports(p_limit integer = 20)` returns rows `{receipt_id,intent_id}` for eligible pending current intents, with actionable steps and an unexpired, unrevoked exact-hash approval. Exhausted approvals permit selecting reconciliation work but cannot dispatch. Completed intents and pending corrections are excluded. Ordering by recent step activity avoids completed early approvals starving later work.
- `claim_housecall_export_step(p_intent_id uuid,p_worker_id text,p_lease_seconds integer = 120)` returns `null` or `{step:<full row>,reconcileOnly:boolean}`. Lease duration is 30–600 seconds. The row includes `id,intent_id,receipt_id,housecall_job_id,step,receipt_page_id,receipt_line_id,payload,payload_hash,idempotency_key,status,lease_token,lease_owner,lease_expires_at,reconcile_only,dispatch_started_at,attempt_count,dispatch_count,external_id,last_error`.
- `consume_housecall_write_approval(p_step_id uuid,p_lease_token uuid)` returns an approval row plus `{step_id,step_payload_hash,idempotency_key}`. It validates the current intent, both durable leases, exact destination/hash, expiry/revocation, and remaining write budget, then increments the budget and records dispatch **before** HTTP. Call it once immediately before the matching prepared request. Errors include `live_write_approval_required` and `conflict`; never send on error or an uncertain RPC response.
- `finish_housecall_export_step(p_step_id uuid,p_lease_token uuid,p_outcome text,p_external_id text = null,p_error_code text = null,p_evidence jsonb = '{}')` returns the updated step. Stale tokens/expired leases are rejected. A duplicate identical success callback is harmless. See outcomes below.
- `request_housecall_step_retry(p_actor_id uuid,p_step_id uuid,p_reason text)` requires an active manager/admin and returns `{stepId,status,reconcileOnly}`. It targets only the exact unresolved step, refuses success/in-flight steps and pending corrections, and grants no write authority. The existing `manager_recovery_command` invokes it for RA-6 `export_attempts.export_step_id` records. Uncertain states remain read-only reconciliation work.

The manual reconciliation endpoint can use claim/finish in a read-only mode without a live approval. The scheduled write runner uses `list_ready_housecall_exports`; a missing/expired approval must never lead to a POST.

## Explicit live grants

`grant_housecall_write_approval(p_actor_id uuid,p_intent_id uuid,p_payload_hash text,p_job_ids text[],p_expires_at timestamptz,p_max_writes integer,p_reason text)` requires an active **admin**, an exact frozen intent hash, a nonempty subset of that intent's destination IDs, an expiry within 24 hours, and a budget of 1–1,000 writes. It returns `{id,intent_id,payload_hash,job_ids,approved_by,reason,expires_at,max_writes,used_writes,revoked_at,created_at}` and appends an audit event. This administrative RPC is not called by receipt approval or ordinary retry. It is a mechanism for recording approval after the user's explicit authorization, not evidence of authorization by itself.

`revoke_housecall_write_approval(p_actor_id uuid,p_approval_id uuid,p_reason text)` requires an active admin and audits revocation. Revocation prevents future consumption; it cannot recall an HTTP request already in flight. No grants are seeded or issued during development/tests except rollback-only synthetic database fixtures.

The application additionally requires its writes-enabled mode and exact test-job allowlist. Before the first claim it must validate the entire intent's destination set, so an unapproved destination on a later line does not cause an earlier partial write.

## Outcomes and reconciliation

| Outcome | Required evidence and effect |
| --- | --- |
| `succeeded` | Nonempty external ID and `{verified:true,housecall_job_id:<exact>,payload_hash:<step hash>}` from exact provider read-back; creates one durable link and success event. One provider object ID cannot satisfy two RA-6 steps on the same job/type. |
| `not_sent` | Allowed only before durable dispatch and outside reconciliation; returns the step to `ready`. |
| `retryable_failure` | Before dispatch, or a definitive rejected HTTP 400/401/403/404/422/429 response; never an uncertain timeout/server failure. |
| `permanent_failure` | A non-reconciliation failure, with definitive rejected response proof if dispatch began. Manager retry can later target that exact failed step. |
| `uncertain` / `not_found` | Becomes `reconcile_required`, including zero matches after timeout. No POST is authorized by absence alone. |

`retryable_failure`/`permanent_failure` after dispatch require `{definitive_rejection:true,http_status:<allowed status>}`. This database capability does not establish that a provider's bulk operation is atomic: the worker currently conservatively treats post-dispatch errors as uncertain pending contract validation.

Claiming an expired in-flight step always sets `reconcileOnly=true`, even if the prior worker died before dispatch. Reconciliation can adopt an exact verified external result; zero/multiple/mismatched results remain manual. A receipt and a destination both remain blocked against overlapping writes while an uncertain step is unresolved. Destination advisory transaction locks prevent races before durable lock rows exist; lease tokens fence later RPCs.

An intent completes only when every frozen image is linked to every destination and every assigned cost line is verified. Only full current-intent completion sets `exported`, completes export work, dispatches the outbox, and starts retention. Completed steps are never replayed. A separate `dispatch_count` permits at most eight HTTP dispatches per step, independently of claim/read-back attempts and approval budgets. Renewing a grant or requesting retry cannot reset this limit; exhausted definitive failures require manual attention, while uncertain outcomes remain reconcilable through reads. Purging removes frozen image metadata, step payloads, and evidence while retaining identity/hash history. Manager history groups by RA-6 step ID so one successful page cannot hide a different failed page.

## Current catalog selection

`manager_search_housecall_jobs(p_search text = '', p_active boolean = true, p_limit integer = 50, p_recent_since timestamptz = now() - interval '30 days', p_upcoming_until timestamptz = now() + interval '90 days')` requires an active authenticated manager/admin and returns full `manager_job_catalog` rows, including exact IDs, `source`, `synced_at`, and `unavailable`. Search treats special characters literally and limits results to 50. The active scope excludes unavailable jobs and includes active jobs in the supplied date window, active jobs without schedules, in-progress/unscheduled active jobs regardless of date, and recently completed jobs in the window. The all scope includes unavailable and archived jobs for inspection. Application settings cap each window at 365 days; SQL allows 366 days to tolerate clock and request differences. Full provider synchronization is unaffected.

An approval-time review trigger rechecks every destination against current catalog availability, even when a historic saved suggestion exists. An unavailable destination raises `invalid_request_job_unavailable` with SQLSTATE `23514`; the entire approval transaction rolls back without an intent or partial export. Drafts may retain unavailable assignments so managers can inspect and replace them.

## Local verification

`npm run test:applied` includes `ra6_applied.sql`, `ra6_jobs_applied.sql`, and `ra6_job_selection_applied.sql`; all SQL suites roll back. Set `SVL_APPLIED_DATABASE_URL` explicitly to the isolated local database. Never point development tests at Housecall or a hosted business database.

`node scripts/ra6-export-concurrency.mjs` additionally opens actual concurrent PostgreSQL transactions and verifies that different receipts cannot steal the same destination before or after the first transaction commits. This script rejects non-loopback database URLs, creates synthetic cross-session fixtures, cleans them up, and makes no provider calls.
