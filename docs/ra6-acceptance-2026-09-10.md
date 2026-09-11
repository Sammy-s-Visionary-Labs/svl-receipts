# RA-6 acceptance — September 10, 2026

RA-6 implementation and controlled test-customer acceptance are complete. The user approved all Housecall operations confined to the four verified Test Customers #1–#4, then chose to **keep quantities beyond two decimal places blocked for manager review**. Production rollout and access to real customers are outside this completion.

## Verified live results

| Synthetic receipt | Verified Housecall result | Final receipt state |
| --- | --- | --- |
| Select fractional base | Customer #2: one image and 0.5 × $42.00 = **$21.00** material; $1.63 tax excluded | Exported |
| Klumm two jobs | One image each on #2 and #4; **$45.00** on #2 and **$99.00** on #4 | Exported |
| Sandman handwritten | Customer #2: one image and 2 × $40.00 = **$80.00** material | Exported |
| Perrysburg supported two pages | Both pages on both #3 and #4; pipe/elbow **$64.50** on #3, cement **$8.00** on #4; $5.62 tax excluded | Exported |
| Original three-decimal case | Both pages on #2 and #3. HCP stored **1.01** for requested **1.005 × $1.00** on #2. The second material, quantity 10.125, was never sent | Partial success; audited manual handoff, automatic export stopped |

Across all acceptance runs: **20 provider writes**, comprising 12 attachments and 8 material creations. Nineteen steps have exact verified success; the rounded material is deliberately excluded from that count. The four successful receipts represent **$317.50** in approved materials. Existing attachment/material rows were preserved. Completed-intent replays created no new records. No customer-facing invoice items, payments, notification settings, job statuses, or real-customer records were changed.

The final run executed nine writes and 51 scoped GETs. Its two receipts completed all two and seven required steps respectively. Each step was dispatched once, then independently read back. Previous failed-run journals remain intact; they were not reused to resend requests.

## Precision decision and recovery

The original 1.005 and 10.125 values remain in the immutable plan. The user selected “Keep blocked for manager review.” The adapter rejects unsupported precision before HTTP, and the worker checks every frozen material before the first claim or image upload. No silent rounding or quantity-one total-only conversion is offered.

An administrator can stop an unfinished export for manual handling. The service first reads its exact Housecall jobs and identifies every dispatched record by stable reference and provider ID. Missing or ambiguous dispatched records prevent closure. A database transaction checks the intent hash, fresh readback, unchanged step versions, active work and actor role, then records the resolution, cancels unfinished work, revokes grants and releases locks. Successful steps remain immutable. The receipt is never marked exported and retention does not start.

This action was used on the original fractional test. Its four successful attachments and the observed rounded material remain in the test jobs as evidence. The untouched second material remains unposted. As this is a synthetic test, the handoff requires no real business cost entry. It unblocked the later handwritten receipt without resending or deleting any Housecall record.

## Read scope, synchronization and local review

The real synchronization worker refreshed exactly the four approved test customers' jobs using customer-filtered requests. Health, customer association, job metadata and cache freshness were verified. The server client requires explicit customer and job read scopes; empty scopes deny reads. A scoped full scan cannot mark another customer's cached jobs unavailable.

The test jobs have no assigned employees. Employee-to-app-user mapping, disabled users, assignment refresh and role checks were verified through controlled unit and applied SQL fixtures, not a business-wide employee lookup. Account-wide catalogs and employee lists were never requested.

The first Select receipt's supplier/date were corrected through manager review against its synthetic image. The handwritten and Klumm receipts also passed local browser review. The final two-page test reused the already simulated Perrysburg images and retained Gemini regression output. “Oak Demo” is only a printed fixture alias: the manager explicitly allocated the pipe/elbow to #3 and cement to #4 by verified IDs. No Housecall lookup for that alias occurred. The original three-decimal fixture was not edited to hide its failed acceptance.

Shop and unidentified consolidated lines remain visible and unassigned, with approval blocked and no export intent. Their unresolved business allocation is covered by the blocked-path test; a future overhead feature requires a separate confirmed rule. Duplicate/control receipts remain local review fixtures and were not exported to manufacture additional live evidence.

## Evidence and operating state

Private, ignored evidence under `.local/ra6/` includes:

- Initial request, approval and journals: `first-live-write-*`, `first-live-material-*`.
- Expanded tests and precision evidence: `expanded-live-*`, `precision-readback.json`, `handwritten-live-journal.jsonl`.
- Final read-only sync/manual handoff: `final-preflight-journal.jsonl`, `final-preflight-results.json`.
- Final successful exports: `final-acceptance-journal.jsonl`, `final-acceptance-results.json`.
- Reviewed plans, image hashes, screenshots and final invariant checks: `supported-multipage-source.json`, `perrysburg-supported-two-pages-preview.json`, `expanded-browser-results/`, `ra6-final-state.json`.

Final database checks found **zero active grants, zero uncertain/in-progress steps, zero destination locks, and one audited manual resolution**. The general environment remains `HOUSECALL_READS_ENABLED=false`, `HOUSECALL_EXPORT_MODE=disabled`, with empty job bindings. Test credentials and real provider IDs are not committed. Local databases on 55322 and 55422 are isolated from the existing development stack on 54322. No hosted migration, deployment, merge, or real-customer enablement was performed.

Provider attachment readback proves exact filename and returned ID, not an independent download/checksum of HCP's stored bytes. The observed upload response was HTTP 201 despite the documented 202; both are treated as acknowledgments requiring readback. Timeout-after-commit faults are exercised with controlled transports, not injected into the live business account.

See [verification and story coverage](ra6-verification.md), [operating controls](ra6-housecall-integration.md), and [provider contract](ra6-housecall-contract.md).
