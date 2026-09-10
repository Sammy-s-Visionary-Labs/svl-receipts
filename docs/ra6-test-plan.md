# RA-6 synthetic receipt and export test plan

## Authorization boundary

The user authorized RA-6 implementation on 2026-09-09 and explicitly retained this restriction:

> For our work on RA-6, I’ll treat live Housecall writes as requiring your explicit approval.

Implementation, local fixture preparation, mock tests, and a dry-run preview do not authorize live writes. This restriction includes attachments, job input materials, retries, approval-triggered/background exports, corrections, reversals, and any mutation of test records inside the live HCP account. No live write has been performed as part of this fixture preparation.

Default write access must stay disabled. Exact verified job IDs and the agreed test scope must be approved before a bounded live run. A customer name, a job name containing “test,” possession of credentials, or a receipt's printed reference is not authorization. Check every destination before the first mutation, then enforce the same policy at the shared transport boundary so no alternate worker or retry path bypasses it.

This document records planned expectations. Passing the fixture consistency script is not proof that the export worker implements them or that HCP supports a particular API operation.

## Available fixtures

The machine-readable source is [`fixtures/ra6/manifest.json`](../fixtures/ra6/manifest.json). These are deterministic synthetic review/export inputs, not OCR predictions. They use destination aliases and `housecallJobId: null`; never post these aliases as job IDs. [`live-bindings.template.json`](../fixtures/ra6/live-bindings.template.json) is deliberately unbound and unapproved.

| Fixture | Expected pre-tax material allocation | Purpose |
| --- | --- | --- |
| Select fractional | Customer 2: $21.00; $1.63 reference tax excluded | 0.5 ton × $42.00, one job, tax exclusion |
| Klumm two jobs | Customer 4: $99.00; Customer 2: $45.00 | One receipt image required at both destinations; distinct line costs |
| Sandman handwritten | Customer 2: $80.00 | Handwritten-reference image planned; deterministic 2 × $40.00 input |
| Sandman consolidated | Assigned: Customer 2 $640.00, Customer 3 $198.00; unresolved $483.00; whole receipt $1,321.00 | Entire approval/export blocked while any line remains unresolved |
| Two-page rounding | Customer 2: $1.01; Customer 3: $38.48; total $39.49 | Half-up cent rounding and every required image page at both jobs |

In the consolidated case, the $483.00 unresolved amount consists of $225.00 with no reliable job reference and $258.00 of Shop lines. Their quantities and amounts remain visible. The known $838.00 is an assignment preview, not an instruction to partially approve or export the receipt. The current manager contract requires a selected known job for every approved line. Do not invent an overhead destination or delete the Shop lines to make approval pass.

These synthetic values were chosen using the source layouts as references. Units, dates, tax values, descriptions, and fixture identifiers are deliberately defined test inputs, not a certified transcription of those source documents. In particular, blank tax fields in originals are not evidence of zero tax.

The duplicate variants preserve the Select synthetic document identity for an exact copy and a second photo. A negative control keeps the same lines and total but changes the synthetic identifier and purchase date. Similar totals alone must not establish a duplicate. A duplicate review decision prevents a second financial export; retries of the same approved intent are separately governed by persisted export identity and reconciliation.

## Receipt image preparation

The five source JPGs in the user's Downloads directory remain unchanged. The first two photos show the same Select Stone order. Do not interpret them as two purchases or automatically attach both as separate pages of an unrelated transaction.

The existing [RA-5 synthetic pack](../fixtures/ra5/README.md) supplies image/OCR controls for multi-job receipts, exact and visual duplicates, separate purchases, multipage receipts, and unresolved extraction fields. Its printed names remain the earlier RA-5 names. Reusing those images alone does not test the new RA-6 name mapping.

The new image pack contains nine generated PNGs, each visually accepted against the intended fields. Actual outputs, hashes, provenance, and review notes are tracked in [`generated-images.json`](../fixtures/ra6/generated-images.json); the [fixture README](../fixtures/ra6/README.md) links each image. App-model extraction and the first local browser review are recorded in [September 10 acceptance evidence](ra6-acceptance-2026-09-10.md); supplier recognition still fails on the four Select variants. The visibly marked “SYNTHETIC — RA6 TEST” documents use these planned labels:

- Benner → **RA6 Test Customer 2**.
- Sophia → **RA6 Test Customer 3**.
- Snyder → **RA6 Test Customer 4**.
- Shop → retain as unresolved until the business treatment is confirmed.

The generated documents replace references wherever they appear, including individual descriptions, use synthetic receipt/ticket identifiers, remove real signatures and unrelated background documents, and preserve the specified arithmetic. The Select controls include another photo variant of the same document and a byte-identical copy. Klumm required one corrective generation to remove unwanted invented address text before visual acceptance. Do not treat generative image text as authentic accounting data or visual review as an OCR evaluation. Numeric dates may require manager confirmation under the strict extraction date policy.

## Offline verification sequence

1. Run `node fixtures/ra6/verify.mjs`. This checks fixture arithmetic, per-job sums, blocked-line totals, page expectations, duplicate identities, existing image availability and hashes, and the lack of actual HCP bindings. It does not load credentials or call providers.
2. Run the domain/client/export-worker tests with injected mock transports. Use distinct mock external IDs per attachment/material target and assert every attempted method, destination, and payload. Reject calls to any unexpected host or destination in the test transport.
3. Test dry-run output against the manifest's approved lines and exact test bindings. Verify that draft changes after approval cannot change queued destinations, costs, receipt-line identities, or image contents.
4. Exercise the failure cases in `exportScenarios`: writes disabled; one disallowed job; duplicate customer labels; Shop/missing assignments; wrong-job verification responses; timeout after save for both attachments and materials; uncertain absence; multiple possible external matches; partial success; duplicate or concurrent queue delivery; and corrections.
5. Assert tax never increases unit or extended material cost. Use integer-cents arithmetic for fractional quantities. Validate complete multipage presence and per-line results before marking a receipt exported.

Rate-limit/authentication/transport failures also need the API-client tests. A rejected request can be retryable only when the transport's evidence establishes the safe next action. An uncertain mutation followed by a temporarily empty read must not automatically issue a second POST. If the API cannot support conclusive reconciliation, leave the result uncertain for operator resolution rather than claiming duplicate prevention.

## Bounded live test prerequisites

The following information remains unavailable or unapproved; none should be invented:

- Exact IDs for all four current test jobs are now read-verified and stored privately. Recheck the intended destination before dispatch; this inventory is not authorization.
- Confirmation that the test jobs' notification and downstream integration settings are suitable for a controlled write. Test records in a live account are still live records.
- Verified API attachment/material request and response contracts, supported reconciliation markers, and a way to inspect persisted results.
- The user's explicit approval of the destinations and concrete previewed payloads for the bounded live run, including what retries are permitted.
- The Shop business rule if testing its resolved path is included; unresolved behavior can be tested offline immediately.

Begin with one approved synthetic receipt and one approved test job. Capture a read-only baseline, preview the exact image and material payload, execute only the authorized scope, then read back the destination and each persisted result. Preserve external IDs and attempt evidence with secrets and signed URLs excluded. Expand to two jobs only after the first case is verified and the expanded scope is authorized.

Use mocks to force timeout-after-save and similar failures; do not intentionally inject failures or duplicate writes into the live business account. Do not automatically delete test records or posted costs afterward. Cleanup, correction, and reversal are also live writes subject to the retained approval boundary.

## Evidence and completion

Record these evidence levels separately:

- **Fixture consistency:** values and files agree internally.
- **Mock contract tests:** the implementation satisfies the asserted routing and recovery behaviors under controlled responses.
- **Synthetic image extraction:** generated images produce the expected review inputs or visible review warnings.
- **Approved live verification:** authorized writes reach the exact test jobs and are read back successfully.

RA-6 live integration completion cannot be inferred from the first three levels. Live-write tasks remain unverified until an approved run produces evidence; the lack of approval must not be bypassed by automatic workers or an ordinary manager approval in the app.
