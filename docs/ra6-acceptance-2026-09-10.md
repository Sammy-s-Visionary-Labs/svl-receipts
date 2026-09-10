# RA-6 acceptance progress — September 10, 2026

Live Housecall writes remain unapproved and disabled. This session made GET requests to verify the four user-created test jobs, sent only synthetic receipt images to Gemini, and used an isolated local Supabase runtime for review. It made no Housecall mutation or hosted database change.

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

## Reproduction and remaining acceptance

Final code validation passed: all 647 automated tests (111 mobile, 272 web, 170 domain, 88 integration and 6 monitoring), lint over 331 files, all workspace type checks, a separate strict type check for the new acceptance scripts, and fixture/hash/provenance verification. The two real-local browser checks and the frozen-request builder were rerun successfully after their final changes. These passing code checks do not erase the four explicitly failing Select supplier-accuracy cases.

Offline checks do not load provider credentials. Live-read and Gemini runners require explicit environment flags:

```sh
RA6_LIVE_HOUSECALL_READS=1 npx vitest run --config scripts/ra6-housecall-readonly.config.ts
RA6_LIVE_GEMINI=1 npx vitest run --config scripts/ra6-evaluation.config.ts
RA5_LIVE_GEMINI=1 RA5_GEMINI_ENV_FILE=apps/web/.env.local RA5_GEMINI_RESULTS_FILE=fixtures/ra6/evaluation/ra5-regression-results.json npx vitest run --config scripts/ra5-evaluation.config.ts
```

The first command requires the existing private inventory and keeps all HCP writes blocked. For a new local review seed, use `RA6_CAPTURE_MODEL_RESPONSE=1` with the synthetic evaluator to retain full synthetic observations privately. The local-review runner additionally requires privately saved runtime settings for the exact isolated ports. Run the seed before creating review intents; it does not reset an existing review environment. The browser runner uses `RA6_LOCAL_BROWSER=1`; the frozen-request builder uses `RA6_PREPARE_PREVIEW=1`. Both require the isolated app/state, and neither authorizes Housecall writes.

The next proposed live scope is exactly one attachment POST and one internal-material PUT to Customer #2, with no automatic resend, deletion or cleanup, within one hour after explicit user approval. The destination and baseline must be rechecked before dispatch. Further jobs, fractional-rounding/multipage cases, preservation of preexisting material rows, retry/reconciliation behavior and cleanup require their own applicable approval and evidence. Supplier recognition remains a documented review requirement; Shop allocation is still unconfirmed. No deployment, remote push or epic completion is implied.
