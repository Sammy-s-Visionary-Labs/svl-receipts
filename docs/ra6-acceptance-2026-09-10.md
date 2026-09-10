# RA-6 acceptance progress — September 10, 2026

The first explicitly approved live test is complete: exactly one synthetic receipt attachment and one $21.00 internal material entry were created and verified on Test Customer#2, job #2000. The user approved those two frozen requests only; both local grants are now revoked and application exports remain disabled. No hosted database change was made. RA-6 remains in progress.

**Subsequent authorization:** the user then approved all HCP actions that only read or change the four verified test customers. That standing approval supersedes per-operation prompts inside this scope. Exact private bindings and authorization are retained separately; general application exports stay disabled and each scoped run still receives bounded internal grants. The expanded test below found a material-precision limitation, so RA-6 is not complete.

## Expanded test under standing customer authorization

At 17:38:40 UTC the newer user instruction was recorded verbatim in the ignored `.local/ra6/test-customer-authorization.json` and the working agreement was updated. Only the three already-bound jobs for Customers #2–#4 were accessed during this run; no account-wide catalog or employee reads were made. The test transport allowlisted exact GET paths and frozen write payloads, checked customer identity on each job read, disabled redirects, and journaled each write before network dispatch. Customer #1 is within the standing authorization but was not needed for these cases.

Three local browser review tests froze the Klumm, two-page rounding and handwritten synthetic receipts. The global review app remained unable to contact HCP. Live outcomes:

| Case | Observed result |
| --- | --- |
| Klumm two jobs | Passed: one image on Customer #2 and #4, $45.00 disposal material on #2 and $99.00 aggregate material on #4. All four steps verified. Existing attachment/material rows on #2 were unchanged. Replaying the completed intent made zero additional writes. |
| Two-page rounding | Partial: both pages verified on both #2 and #3. The first material request sent quantity **1.005**, unit cost **100 cents**, but HCP stored **1.01**. Exact reconciliation rejected that mismatch and stopped. The second material, quantity 10.125, was never sent. |
| Handwritten receipt | Not exported: zero writes. The unresolved material on Customer #2 correctly prevented this later receipt from acquiring the job export lock. Both handwritten steps remain ready. |

The expanded bundle attempted **nine writes**: six attachment uploads (201) and three material writes (200). All were confined to the verified test jobs and none was repeated. A separate four-GET inspection confirmed the persisted 1.01 quantity and no material on Customer #3. The partial rounding receipt remains `partial_success` with four successful attachment steps, one `reconcile_required` material, and one untouched material. Its original quantities remain 1.005 and 10.125 in the immutable local plan. No cleanup or silent cost/quantity conversion was performed.

The adapter now blocks dispatch of quantities with more than two decimal places. The worker checks all frozen material quantities before any provider read, claim or attachment dispatch; the preview displays the precision block while preserving the source values. The payload builder still represents original three-decimal inputs for historical inspection and GET-only reconciliation. The underlying domain half-up calculation remains unchanged. This is a conservative restriction based on the observed 1.005 → 1.01 conversion, not a claim that every possible provider rounding case has been characterized.

Validation after the fix: **96 integration tests and 274 web tests pass**, including prevention of the first attachment when a later line has unsupported precision, direct-client rejection before network, and continued GET-only reconciliation of historical mismatches. A fourth local browser check verified the visible precision warning and unchanged frozen quantities. Web, integration and acceptance-script type checks and repository lint also passed.

Private evidence: `expanded-live-journal.jsonl`, `expanded-live-results.json` (the completed Klumm case), `precision-readback.json`, `handwritten-live-journal.jsonl`, `standing-approval-final-state.json`, and the local precision-warning screenshot. Final local state has **zero active per-run grants**, with standing customer authorization retained. All journals and actual provider IDs remain ignored. Resolving the fractional representation/mismatch and completing the handwritten test remain outstanding; the original plan must not be silently rewritten or its uncertain material resent. Full-business catalog/employee reads remain outside the current authorization.

## Housecall reads and contract correction

The copied web environment contains the API key. The application configuration remains `HOUSECALL_READS_ENABLED=false`, `HOUSECALL_EXPORT_MODE=disabled`, and an empty `HOUSECALL_TEST_JOB_IDS`. The explicitly opted-in verification script uses its own GET-only transport, an exact URL set from the ignored private inventory, and a twelve-read budget. It cannot send a body, change configuration or dispatch a write.

Actual HCP responses established that array query keys need brackets, including a single value. Scalar `expand=attachments` returned HTTP 400, “Expand must be an array of strings”; scalar `work_status=unscheduled` returned HTTP 400, “work_status filter must be an array of strings”. Bracketed forms returned HTTP 200. The shared client now sends `expand[]=attachments` and `work_status[]=...` (URL encoded). Regression assertions cover the request shape.

The final baseline verified each exact job/customer association, expanded attachment collection, internal-material collection, and customer-filtered job list:

| Test customer | Job number | Status | Notifications | Existing attachments / materials |
| --- | --- | --- | --- | --- |
| #1 | 1990 | Scheduled | On | 1 / 1 |
| #2 | 2000 | Needs scheduling | Off | 0 / 0 |
| #3 | 2001 | Needs scheduling | Off | 0 / 0 |
| #4 | 2002 | Needs scheduling | Off | 0 / 0 |

No test job had assigned employees. Employee-to-app-user mapping and full-business catalog synchronization remain separate acceptance items. GET success does not establish permission or behavior of write endpoints. Notification observations do not establish all downstream integration settings. Customer #1 remains excluded from the initial proposal.

Private results and real destination bindings are in `.local/ra6/housecall-readonly-results.json` and `.local/ra6/test-jobs.json`; neither is a write approval. The committed binding template remains empty.

## Synthetic extraction and review

The evaluator used the app's actual `normalizeExtractionPage` and Gemini receipt adapter, with the same default `gemini-3.5-flash-lite` model as the extraction worker. Nine original PNGs represent eight cases, including two pages of one receipt. Image hashes and normalized predictions are retained in `fixtures/ra6/evaluation/gemini-results.json`.

The consolidated invoice initially produced an empty evidence entry for a null job hint, which the strict parser correctly rejected. Prompt version `ra6-receipt-v1.3` adds only an instruction to omit evidence entries for missing/blank fields and never emit empty evidence text. The domain validator remains strict. A broader supplier-identification prompt experiment was not retained; its evaluation reports remain available to explain that choice.

Final RA-6 result: **8/8 valid extraction responses; 4/8 cases pass every expected field check.** The four Select variants incorrectly identify the large synthetic stamp as the vendor. Their other checked fields match; all tested numeric values, descriptions, document identities, job hints and page assignments match the manifest. This is a retained accuracy limitation, not a passing automatic supplier-extraction result. Numeric dates can remain explicitly unresolved under the strict date-order policy.

The final prompt also passed **11/11 existing RA-5 synthetic controls**, with results saved separately in `fixtures/ra6/evaluation/ra5-regression-results.json`. The original RA-5 evidence was not overwritten. These are synthetic accuracy checks, not real-vendor accuracy claims.

The isolated runtime uses project `svl-ra6-verification`, local API port 55321, database port 55322, and review app port 3196. It restored all 26 migrations into an empty database, then loaded the retained predictions, original synthetic images, three verified candidate test jobs and a local test administrator. Readability is explicitly labeled as a local manual visual precondition; no new readability-model run is claimed. Extraction persistence and job/duplicate intelligence use the actual application functions. Local receipt records retain the v1.2 extraction attempt used when they were seeded; subsequent evaluation results do not overwrite their history.

Two browser checks against real local auth/storage/database passed:

1. Correct the Select supplier against its visible image, confirm September 1, 2026 from the fixture manifest, choose Customer #2 by exact ID, and approve the local review. The frozen preview contains one original PNG and one material line, **0.5 ton × $42.00 = $21.00**, excluding $1.63 tax. Both write-disabled and destination-not-approved blocks remain visible.
2. Keep all six consolidated lines visible, select only the three known customer assignments, and leave Shop plus the missing job unresolved. Approval is blocked and no export intent is created for that receipt.

The preview builder then read the frozen database steps and actual private local image bytes through the production payload builders. It saved exact method/path/body, filename, image SHA-256, request fingerprints and intent hash in `.local/ra6/first-live-write-request.json` and a reviewable Markdown companion. Database verification found **zero write approvals, zero dispatched steps and zero Housecall result links**. Local receipt approval did not grant live permission.

## First approved live export

The user replied **“yes you have my approval”** to the concrete two-request preview. Approval was recorded at **17:26:23 UTC**, with the original fixed expiry **18:26:23 UTC**, a two-write total, no resends and no cleanup. The one-use runner verified the immutable intent and request hashes, exact destination/customer, notifications off, empty initial attachment/material collections, image bytes and exact material JSON. A private append-only journal reserved each operation before network dispatch. Global application environment files were never enabled for export.

| Operation | Actual result | Readback verification |
| --- | --- | --- |
| One attachment POST, 17:32:08 UTC | HTTP 201 | Exactly one attachment, with the complete frozen filename and a stable provider attachment ID |
| One material PUT, 17:34:29 UTC | HTTP 200 | Exactly one material, matching reference, description, name, quantity 0.5 and unit cost 4,200 cents |

The upload exposed a real API difference: the published contract advertised HTTP 202, but the live request returned HTTP 201. The client conservatively stopped before the material request. A subsequent GET found the uploaded attachment; the recovery runner reconciled that existing result through the actual application worker with writes disabled, without another POST. The client now accepts both 201 and 202 as acknowledgments requiring separate readback; a parameterized regression test covers both.

The initial local grant was revoked after the stop. The remaining operation used a new one-write local grant under the **same explicit user approval and unchanged expiry**, with the already-dispatched attachment hash permanently excluded by the transport journal. This was the material's first dispatch, not a retry. That grant was revoked immediately after completion.

At **17:34:30 UTC**, both frozen export steps were `succeeded`, each with `dispatch_count=1` and a verified provider ID. The local receipt was `exported`. Final HCP reads found one attachment and one material; notifications were still off and the job still needed scheduling. The exported material cost was **$21.00**; the $1.63 receipt tax was excluded. There were **two live writes total and fourteen scoped GET requests** across the initial and recovery runs. No other Housecall destination or write endpoint was contacted.

Private approval, dispatch and readback evidence is retained in `.local/ra6/first-live-write-approval.json`, `first-live-write-journal.jsonl`, `first-live-write-results.json`, `first-live-material-journal.jsonl` and `first-live-material-results.json`. The original failed runner result remains intact as evidence of the 201 mismatch; the later successful result documents resolution. These ignored records contain the actual destination and provider IDs and must not be committed. Attachment verification is by filename and provider ID, not an independent download of the uploaded bytes.

## Reproduction and remaining acceptance

Final code validation passed: all 647 automated tests (111 mobile, 272 web, 170 domain, 88 integration and 6 monitoring), lint over 331 files, all workspace type checks, a separate strict type check for the new acceptance scripts, and fixture/hash/provenance verification. The two real-local browser checks and the frozen-request builder were rerun successfully after their final changes. These passing code checks do not erase the four explicitly failing Select supplier-accuracy cases.

Offline checks do not load provider credentials. Live-read and Gemini runners require explicit environment flags:

```sh
RA6_LIVE_HOUSECALL_READS=1 npx vitest run --config scripts/ra6-housecall-readonly.config.ts
RA6_LIVE_GEMINI=1 npx vitest run --config scripts/ra6-evaluation.config.ts
RA5_LIVE_GEMINI=1 RA5_GEMINI_ENV_FILE=apps/web/.env.local RA5_GEMINI_RESULTS_FILE=fixtures/ra6/evaluation/ra5-regression-results.json npx vitest run --config scripts/ra5-evaluation.config.ts
```

The first command requires the existing private inventory and keeps all HCP writes blocked. For a new local review seed, use `RA6_CAPTURE_MODEL_RESPONSE=1` with the synthetic evaluator to retain full synthetic observations privately. The local-review runner additionally requires privately saved runtime settings for the exact isolated ports. Run the seed before creating review intents; it does not reset an existing review environment. The browser runner uses `RA6_LOCAL_BROWSER=1`; the frozen-request builder uses `RA6_PREPARE_PREVIEW=1`. Both require the isolated app/state, and neither authorizes Housecall writes.

After the live contract fix, all **89 integration tests** and the strict acceptance-script type check passed. The guarded remaining-material acceptance run passed after GET-only attachment reconciliation. The committed `ra6-approved-live` runner is skipped by default, requires a separate private human-approval record matching the exact proposal, and refuses an existing dispatch journal. Its remaining-material mode only permits the never-dispatched material after verifying the prior attachment-only attempt; it cannot repeat either completed run. Do not delete journals or renew expiry to rerun a live test.

Further jobs, three-decimal fractional-rounding/multipage cases, preservation of preexisting material rows, broader failure/reconciliation behavior and cleanup still require applicable approval and evidence. The first test established material creation on an initially empty job, not append preservation on a populated job. Employee mappings/full-business catalog acceptance remain outstanding. Supplier recognition remains a documented review requirement; Shop allocation is still unconfirmed. No deployment, remote push or epic completion is implied.
