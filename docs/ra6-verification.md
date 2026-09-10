# RA-6 local implementation and verification

Date: 2026-09-09. Branch: `epic/ra-6-housecall-integration-safe-export`, based on `ad5e578` (merged RA-4/RA-5). The epic remains in progress. No live Housecall account reads or writes, hosted database migrations, deployment, or remote branch push were performed during this implementation.

## Epic coverage and provider access

| Story | Implemented local behavior | Housecall access when separately enabled |
| --- | --- | --- |
| RA-42 | Shared server-only client, fixed origin, normalized errors, timeouts, rate-limit metadata, admin health check | GET for health; the shared transport supports only explicitly permitted export writes |
| RA-43 | Bounded job sync, atomic catalog commit, freshness, active/recent search window, exact IDs, employee mapping | GET job lists/details; manager search reads the local catalog |
| RA-44 | Atomic approved snapshot, supplier reference, image manifest, intent/step hashes and per-destination work | Local database only; receipt approval does not grant live write authority |
| RA-45 | Private image checksum check, one required upload per page per destination, asynchronous readback | POST attachment, then GET verification; explicit live approval required |
| RA-46 | Approved quantity and integer-cent unit cost, tax exclusion, stable receipt-line reference | PUT Job Input Materials, then GET verification; explicit live approval required |
| RA-47 | Receipt/destination leases, exact step projection, partial progress and complete-intent retention gate | Coordinates the approved attachment/material operations |
| RA-48 | Durable write budgets, succeeded-step skip, read-before-retry, uncertain-outcome fencing, correction proposals | GET reconciliation; any permitted new dispatch remains subject to explicit live approval |
| RA-49 | Injected provider contracts, timeout-after-commit cases, authorization/decimal/routing tests, real local concurrency test | Automated development tests make no Housecall requests; live acceptance remains pending |

Job/customer creation, customer invoice items, payments, paid/unpaid fields, job status changes, and automatic deletion/reversal are not exposed by the receipt export adapter. Creating additional HCP test jobs is a separate live operation and is covered by the user's explicit-approval boundary.

## Verification evidence

| Check | Final local result |
| --- | --- |
| `npm run lint` | Passed; 315 files checked |
| `npm run typecheck` | Passed in all four workspaces |
| `npm test` | 647 passed: 6 monitoring, 111 mobile, 272 web, 170 domain, 88 integration tests |
| `npm run build:web` | Production build passed |
| `npm run test:e2e` | 34 browser tests passed with fixture credentials and Housecall explicitly disabled |
| `npm run test:ra6:fixtures` | All fixture arithmetic, file hashes, and image provenance checks passed; 9/9 images generated and visually accepted |
| Isolated Supabase replay and `npm run test:applied` | All 26 migrations replayed; all 11 rollback-only SQL suites passed |
| `npm run test:ra6:concurrency` | Actual two-session destination locking passed |
| Supabase SQL lint at error level | No errors |

The local suites cover disabled credentials/configuration, receipt-wide destination rejection before dispatch, exact payload permissions, grant expiry/revocation/budgets, wrong-job readback, changed image bytes, asynchronous attachment acceptance, material timeout after provider commit, ambiguous/absent readback, multipage partial success, step-specific retries, correction fencing, and competing workers. These are controlled test results, not claims about actual HCP persistence.

Database verification used an isolated local Supabase project `svl-ra6-verification` on port 55322. The existing development stack on 54322 was not reset. Migrations were replayed from scratch, SQL suites rolled back, and cross-session concurrency fixtures were explicitly cleaned up. Users, receipts, write approvals, export steps, and leases were all empty after cleanup. The temporary project was stopped with its data preserved; the existing development database remained healthy.

The nine [synthetic PNG fixtures](../fixtures/ra6/README.md) were generated using the built-in imagegen tool and visually reviewed against the deterministic fixture manifest. Their actual file hashes, dimensions, exact prompts, and generation/edit provenance are retained in `fixtures/ra6/generated-images.json`. The verifier checks five receipt cases, three duplicate/separate-purchase variants, sixteen expected export scenarios, nine new images, and eight older RA-5 image references. Fixture consistency and visual review do not prove app-model extraction accuracy.

## Remaining acceptance

September 10 update: [read-only API verification, synthetic extraction results and the local browser review](ra6-acceptance-2026-09-10.md) are now recorded. The first exact export request is prepared but unapproved. The initial dated verification above remains unchanged.

- API connection, exact customer/job IDs, expanded attachments, materials and customer-filtered catalogs now pass read verification. Full-business synchronization, employee mappings and actual write capabilities remain to be verified. Customers #2–#4 have notifications off; #1 has notifications on. The committed fixture template deliberately retains null HCP bindings.
- Extraction ran for all eight new cases. Four Select variants retain a supplier-name error; the first receipt's supplier and date were corrected through local browser review. The first frozen destination/line/image preview is ready. Broader review and real-vendor accuracy remain separate acceptance work.
- Obtain explicit user approval for the exact test jobs, immutable payloads, write count and time window. A live test job remains a record in the real business account.
- Verify attachment filename preservation and asynchronous visibility, material append behavior and preservation of existing rows, three-decimal quantity arithmetic, and returned external IDs. The documented attachment schema has no content hash, so filename/ID matching is not independent byte-identity proof.
- Keep Shop and the unidentified consolidated line unresolved until the business allocation rule is confirmed. Confirmed corrections/reversals require a separate approved procedure; this implementation records proposals and blocks uncertain work rather than automatically changing existing costs.

The application stays disabled for live writes until those requirements are met. A local commit or passing test suite does not complete live integration acceptance.
