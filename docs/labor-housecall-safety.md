# Labor Housecall dispatch and manual resolutions

Labor sending still requires `LABOR_HOUSECALL_SEND_ENABLED=1`, configured Housecall reads, all-job access, a current immutable manager approval and a separate exact-snapshot send confirmation. Receipt export flags never enable labor writes.

For the user-authorized test job, set the server-only `LABOR_HOUSECALL_TEST_MODE=1`. This confines labor send and verification calls to `job_ba8e7f222367485dbb201f84fe83f9e6`. Optionally set `LABOR_HOUSECALL_ALLOWED_JOB_IDS` to a comma-separated job-ID allowlist. When both settings are present, their intersection applies. An explicitly empty/malformed allowlist or unrecognized test-mode value disables provider access. Omitting both restrictions preserves normal manager-reviewed job selection. These settings do not approve any source hours or trigger a send.

Before adopting an existing matching material reference, verifying an uncertain attempt, or accepting post-write readback, the service fetches the exact job and checks its current customer against the frozen approval. A mismatch before durable dispatch is a failed attempt without a write; a mismatch after dispatch remains uncertain. The adapter separately checks customer identity and writable job state before a new PUT. Uncertain submissions remain verification-only even when readback finds no material.

The [official Housecall OpenAPI](https://stoplight.io/api/v1/projects/housecallpro/housecall-public-api/nodes/reference/housecall.v1.yaml?fromExportButton=true&snapshotType=http_service&deref=optimizedBundle), retrieved October 29, 2026, still documents creation when a material has no `uuid`. Each labor or receipt request includes only its own approved material row, with no unrelated UUIDs or replacement list. The contract test runs receipt and labor writes concurrently against a simulated append endpoint and checks both exact readbacks and preservation of unrelated rows. This test establishes request isolation; it does not establish live provider concurrency behavior. Existing receipt acceptance separately documented real append preservation. Live labor acceptance must use the nominated test job and synthetic fixture, never actual unreviewed labor mappings.

## Controlled live provider acceptance, October 29, 2026

The user-authorized pilot completed at 19:10 UTC against only the nominated job. It used the actual application preview, frozen approval, durable approval/send RPCs, Housecall adapter and exact readback. Synthetic source hours and a synthetic manager were stored in a dedicated disposable local database; the production labor ledger and real employee/job mappings were not used.

The pilot made exactly **one provider PUT**, creating one quantity-1 material at **$0.00** for **1.00 synthetic paid hour**. Its description labels the worker **TEST ONLY** and **NOT PAYROLL**. The original material count was one; readback returned two. The preexisting material's provider identity and all projected fields were unchanged. The synthetic reference appeared exactly once with a provider material ID, and exact name, description, quantity and cost matching succeeded. A second send through the application was rejected before another write. The local audit trail contains approval, send claim, durable dispatch and sent events.

Private evidence is retained in `.local/verification/labor-live-acceptance-plan.json`, with the opt-in harness and its README beside it. It includes before/after material projections, the immutable request, resulting provider reference and database audit. Credentials are excluded. The zero-cost TEST material remains on the nominated job; the harness performs no cleanup or additional provider mutation.

This pilot proves the actual provider path and durable duplicate prevention for the synthetic zero-cost case. It does not by itself establish hosted production authentication, deployment configuration, recurring Supercrew imports, real job-link decisions, actual worker rates, live overtime-cost posting, or simultaneous independent provider writes. Those rollout and business checks retain their own evidence. Initial production checks can keep `LABOR_HOUSECALL_TEST_MODE=1`; normal manager-reviewed destinations require removing that restriction and any test-only allowlist after the hosted checks. Changing these settings never sends an approval automatically.

## Record a completed manual resolution

A manager can document a correction or reconciliation they have already completed in Housecall. The app records the attestation, reason, reference and evidence. It does not perform the provider edit or claim that the attestation is provider-verified readback.

`GET /api/manager/labor/corrections?approvalId=<uuid>` returns `{corrections:[...]}`. `POST /api/manager/labor/corrections` accepts:

```json
{
  "approvalId": "the saved approval UUID",
  "expectedSnapshotHash": "the saved approval SHA-256",
  "requestId": "a fresh UUID, retained across request retries",
  "confirmed": true,
  "reason": "Why the manual resolution was necessary (10–2000 characters)",
  "providerReference": "The corrected Housecall material ID or other exact resolution reference (1–500 characters)",
  "evidence": "What was checked and corrected, including the resulting hours/cost or why no posting was required (10–4000 characters)"
}
```

The response is `{correction:{id,approvalId,snapshotHash,recordedBy,recordedAt,reason,providerReference,evidence}}`. The actor comes from the signed-in session and is rechecked in the database. Only sent or previously dispatched uncertain approvals qualify; an active send cannot be resolved while in flight. Retrying the same request ID and exact details returns the same record. Reusing it for changed details returns a conflict. New evidence can be added as a new immutable record.

Migration `20261029185332_labor_manual_resolutions.sql` adds a service-only RLS table, immutable-record trigger, role-checked read/write RPCs and an approval event. No original approval, attempt, provider reference or source reservation is changed. Uncertain provider status remains uncertain, even after a manager attestation; no automatic resend or reserved-time release is authorized. No provider credentials or lease tokens appear in correction responses or events.

Focused tests cover destination gates, changed-customer adoption, uncertain readback, manager access, evidence validation, retry identity and the receipt/labor append contract. The rollback SQL suite `labor_manual_corrections_applied.sql` verifies actual grants/RLS, active-role checks, active-send exclusion, idempotency, immutable evidence and unchanged approvals/reservations on a disposable migrated database.
