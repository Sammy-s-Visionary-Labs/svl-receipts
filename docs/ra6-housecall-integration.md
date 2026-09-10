# RA-6 — Housecall integration and safe export

## Authorization boundary

The current user authorization covers all Housecall reads and writes confined to the four verified Test Customers #1–#4. It supersedes per-operation approval prompts inside that scope; it does not authorize real-customer or account-wide access. See `AGENTS.md` and the ignored `.local/ra6/test-customer-authorization.json` for the retained authorization and exact bindings.

Ordinary receipt approval freezes instructions; it does not grant provider write authority. Standing customer authorization is enforced with per-run immutable requests, bounded database grants and exact transport scopes. No approval or destination is seeded by migrations. General reads and exports remain disabled. Customers #2–#4 had notifications off and received the controlled writes; #1 was read only. [Live acceptance is complete](ra6-acceptance-2026-09-10.md).

## Controls and execution

The [integrated test flow](ra6-integrated-flow.md) adds an optional bounded
standing session. In that explicitly configured preview, manager approval also
reserves the session budget and creates the immutable write grant atomically.

- `HOUSECALL_READS_ENABLED=false` disables provider reads and exports by default. Read-only connection checks and job refresh have admin routes and Settings controls.
- `HOUSECALL_EXPORT_MODE=disabled` is the default. The only supported write mode is `approved_test`; unknown values remain disabled.
- `HOUSECALL_TEST_CUSTOMER_IDS` and `HOUSECALL_TEST_JOB_IDS` are required exact read scopes. Empty scopes deny server reads; enabling the read flag alone cannot scan the business. Health probes use a customer-filtered GET.
- `HOUSECALL_TEST_JOB_IDS` contains up to twenty exact provider job IDs. The entire intent is checked before the first provider call, so a receipt containing an unapproved destination cannot partly export earlier lines.
- An additional database authorization covers an immutable intent hash, exact destinations, an expiry of at most 24 hours, and a bounded write count. It requires an active administrator, is audited, and is consumed before external I/O. There is no ordinary manager or public API that grants this approval.
- The HTTP adapter checks the exact prepared request hash, actual image bytes, destination ID, expiry, and single-use permit. It re-reads the destination before writing and refuses canceled, deleted, locked, or unknown-status jobs. It exposes no invoice, payment, customer creation, or job creation operations.
- Persistent receipt/destination locks and step leases serialize different workers. Expired in-flight work requires reconciliation. Missing evidence after an uncertain write never authorizes another write.
- Receipt images are fetched privately and must match their frozen size and SHA-256. Multipart filenames carry stable receipt/intent/page/content references. Provider attachment metadata exposes no checksum, so filename and returned ID readback cannot prove provider-side byte identity.
- Quantities beyond two decimal places are blocked before any receipt dispatch, per the user’s choice. Preserve the original value for review; never silently round or substitute a total-only line.
- Job Input Materials use the documented internal materials endpoint and integer-cent unit costs. Each dispatch uses a one-element bulk request and omits the provider UUID only for creation. Stable receipt/intent/line references enable exact readback matching; tax and customer-facing invoice fields are not included.
- Every required image on each distinct destination and every material line must have verified success before the receipt is exported or retention begins. Partial success remains explicit.

`GET /api/manager/receipts/:id/export-preview` returns a safe projection of the current frozen plan, destination names/IDs, cost arithmetic, images, and step outcomes. It makes no Housecall calls. `POST /api/manager/receipts/:id/export-reconcile` can read back uncertain results while writes are disabled (read access and destination allowlist must still be configured). It cannot consume write approvals or dispatch writes.

The separate Housecall cron runs once daily and is inert by default. Approval kicks are scoped to the approved receipt and still require an existing separate authorization. Large/slow exports continue through the durable step state on subsequent authorized runs rather than exceeding the route deadline.

## Job synchronization

Housecall job data is stored under immutable IDs. The public API has paginated lists, but no documented `updated_since` filter or free-text job search. The implementation reads a bounded complete newest-first scan, validates pagination totals and duplicate IDs, then persists changed/unknown-timestamp jobs with an overlap window. It refreshes observed-job freshness and performs a full catalog update at least weekly. Failed or incomplete scans retain the prior catalog. Customer-scoped scans persist their scope and mark missing rows unavailable only within it; they do not delete history. Every destination is independently checked again before a write.

Manager searches use the synchronized catalog for active/recent or all jobs. The default local window covers 30 days behind and 90 days ahead; `HOUSECALL_ACTIVE_LOOKBACK_DAYS` and `HOUSECALL_ACTIVE_LOOKAHEAD_DAYS` each accept 1–365 days. In-progress and unscheduled active jobs remain visible regardless of dates. Recent completed jobs appear in the default window, while the all-jobs option retains older history. Full provider synchronization is independent of these local search filters.

Job status, schedule, customer, address, and provider employee IDs are retained; an explicit administrator-controlled employee-to-app-user mapping supplies assignment context. No worker identity is inferred from matching names. Fields the provider does not supply, including unavailable GPS context, are not invented. Suggestions exclude unavailable jobs and Housecall rows with missing, invalid, or older-than-26-hour sync evidence. The manager picker refreshes stored suggestions and saved assignments by exact catalog ID, shows stale/unavailable state, and blocks known unavailable destinations in both the UI and the atomic approval transaction.

## Validation and completion

See the [local verification report](ra6-verification.md), [provider contract](ra6-housecall-contract.md), [synthetic test plan](ra6-test-plan.md), and the local SQL suites. The fixture manifest uses logical destination aliases and null Housecall IDs; it cannot be used as a live export configuration.

The [synthetic image pack](../fixtures/ra6/README.md) contains nine generated, visually reviewed PNGs with saved prompts and hashes. Extraction/review and controlled live acceptance are documented separately. Four receipts fully exported; the retained unsupported-precision case was explicitly closed for manual handling without success or repeat dispatch. Shop/missing assignments remain blocked.

`POST /api/admin/receipts/:id/close-export` requires an active administrator, exact intent/hash, reason and explicit confirmation. It performs GET-only readback, then atomically records fresh evidence, cancels unfinished work, revokes grants and releases locks. Ambiguous/missing dispatched records or changed/active steps block closure. Existing provider rows stay unchanged; the receipt remains partial/failed and retention does not start. This action is visible to admins in the frozen export preview.

Corrections stay separate audited proposals; automatic deletion/replacement of live costs is not implemented. A closed manual handoff cannot be retried as the original intent.

Administrator health checks persist the last check, last successful check and classified error without credentials or provider bodies. Settings includes server-key rotation guidance. Every request carries an opaque receipt/sync correlation ID plus sequence suffix. After an authentication/authorization failure, the current client run stops further requests; a fresh health check/client is required after correcting credentials. This is not an account-wide circuit breaker.

Completion of this branch does not deploy it or enable real-customer access.
