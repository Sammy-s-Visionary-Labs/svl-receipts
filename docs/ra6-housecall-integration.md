# RA-6 — Housecall integration and safe export

## Authorization boundary

The user's instruction for this work is: **"For our work on RA-6, I’ll treat live Housecall writes as requiring your explicit approval."** This applies to test jobs inside the live account as well as business jobs, and includes attachments, material costs, retries, cleanup, and job/customer creation.

Implementation and local/mock testing do not authorize live writes. Ordinary receipt approval freezes export instructions; it does not create a Housecall write authorization. No approval or destination ID is seeded by these migrations.

On 2026-09-10, the user supplied links for Test Customer#1 through #4 and reiterated that every data write during testing requires their approval. Read-only inspection of the signed-in Housecall UI resolved all four exact job IDs. Customer links for #1–#3 were resolved through their Jobs tabs. The private inventory is `.local/ra6/test-jobs.json` (ignored by Git); it is not a runtime allowlist or authorization. Customers #2–#4 show notifications off and are the proposed initial test destinations. Customer #1 shows notifications on. No notification setting or business record was changed. The key was subsequently copied from the original checkout. Read-only API verification now passes for all four jobs; see [September 10 acceptance evidence](ra6-acceptance-2026-09-10.md). Application reads/exports remain disabled.

## Controls and execution

- `HOUSECALL_READS_ENABLED=false` disables provider reads and exports by default. Read-only connection checks and job refresh have admin routes and Settings controls.
- `HOUSECALL_EXPORT_MODE=disabled` is the default. The only supported write mode is `approved_test`; unknown values remain disabled.
- `HOUSECALL_TEST_JOB_IDS` contains up to twenty exact provider job IDs. The entire intent is checked before the first provider call, so a receipt containing an unapproved destination cannot partly export earlier lines.
- An additional database authorization covers an immutable intent hash, exact destinations, an expiry of at most 24 hours, and a bounded write count. It requires an active administrator, is audited, and is consumed before external I/O. There is no ordinary manager or public API that grants this approval.
- The HTTP adapter checks the exact prepared request hash, actual image bytes, destination ID, expiry, and single-use permit. It re-reads the destination before writing and refuses canceled, deleted, locked, or unknown-status jobs. It exposes no invoice, payment, customer creation, or job creation operations.
- Persistent receipt/destination locks and step leases serialize different workers. Expired in-flight work requires reconciliation. Missing evidence after an uncertain write never authorizes another write.
- Receipt images are fetched privately and must match their frozen size and SHA-256. Multipart filenames carry stable receipt/intent/page/content references. Provider attachment metadata exposes no checksum, so filename and returned ID readback cannot prove provider-side byte identity.
- Job Input Materials use the documented internal materials endpoint and integer-cent unit costs. Each dispatch uses a one-element bulk request and omits the provider UUID only for creation. Stable receipt/intent/line references enable exact readback matching; tax and customer-facing invoice fields are not included.
- Every required image on each distinct destination and every material line must have verified success before the receipt is exported or retention begins. Partial success remains explicit.

`GET /api/manager/receipts/:id/export-preview` returns a safe projection of the current frozen plan, destination names/IDs, cost arithmetic, images, and step outcomes. It makes no Housecall calls. `POST /api/manager/receipts/:id/export-reconcile` can read back uncertain results while writes are disabled (read access and destination allowlist must still be configured). It cannot consume write approvals or dispatch writes.

The separate Housecall cron runs once daily and is inert by default. Approval kicks are scoped to the approved receipt and still require an existing separate authorization. Large/slow exports continue through the durable step state on subsequent authorized runs rather than exceeding the route deadline.

## Job synchronization

Housecall job data is stored under immutable IDs. The public API has paginated lists, but no documented `updated_since` filter or free-text job search. The implementation reads a bounded complete newest-first scan, validates pagination totals and duplicate IDs, then persists changed/unknown-timestamp jobs with an overlap window. It refreshes observed-job freshness and performs a full catalog update at least weekly. Failed or incomplete scans retain the prior catalog. Full scans mark missing provider rows unavailable; they do not delete history. Every destination is independently checked again before a write.

Manager searches use the synchronized catalog for active/recent or all jobs. The default local window covers 30 days behind and 90 days ahead; `HOUSECALL_ACTIVE_LOOKBACK_DAYS` and `HOUSECALL_ACTIVE_LOOKAHEAD_DAYS` each accept 1–365 days. In-progress and unscheduled active jobs remain visible regardless of dates. Recent completed jobs appear in the default window, while the all-jobs option retains older history. Full provider synchronization is independent of these local search filters.

Job status, schedule, customer, address, and provider employee IDs are retained; an explicit administrator-controlled employee-to-app-user mapping supplies assignment context. No worker identity is inferred from matching names. Fields the provider does not supply, including unavailable GPS context, are not invented. Suggestions exclude unavailable jobs and Housecall rows with missing, invalid, or older-than-26-hour sync evidence. The manager picker refreshes stored suggestions and saved assignments by exact catalog ID, shows stale/unavailable state, and blocks known unavailable destinations in both the UI and the atomic approval transaction.

## Local validation and remaining acceptance

See the [local verification report](ra6-verification.md), [provider contract](ra6-housecall-contract.md), [synthetic test plan](ra6-test-plan.md), and the local SQL suites. The fixture manifest uses logical destination aliases and null Housecall IDs; it cannot be used as a live export configuration.

The [synthetic image pack](../fixtures/ra6/README.md) contains nine generated, visually reviewed PNG files with saved prompts and hashes. App-model extraction has run: four cases pass every field check and four Select variants still require supplier correction. Local browser review corrected the first receipt and prepared its frozen preview. Live write acceptance remains pending: obtain explicit approval for that concrete test, then verify attachment filename preservation/visibility, material append behavior and existing-row preservation, fractional quantity arithmetic, and returned external IDs. Mock tests do not prove these provider behaviors.

Corrections are preserved as separate audited commands and cannot silently add a new set of costs over the old intent. Uncertain cases stay blocked for reconciliation; deletion/replacement of live costs requires a separately approved correction procedure.

No deployment or live Housecall acceptance is implied by committing this branch.
