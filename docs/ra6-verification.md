# RA-6 completion and verification

Completed September 10, 2026 on `epic/ra-6-housecall-integration-safe-export`, based on `ad5e578` (merged RA-4/RA-5). Implementation and controlled test-customer acceptance are complete. Production rollout is separate; general Housecall access remains disabled. See the [live acceptance report](ra6-acceptance-2026-09-10.md).

| Story / subtasks | Delivered behavior |
| --- | --- |
| RA-42 / RA-160–162 | Shared server-only client, fixed origin, request correlation, classified errors/rate hints, per-run authorization-failure stop, admin health history and key-rotation guidance |
| RA-43 / RA-163–165 | Bounded customer-scoped synchronization, atomic cache/freshness, active/recent/all search, exact-ID selection, explicit employee mapping, invalid-job guards |
| RA-44 / RA-166–168 | Atomic immutable approval snapshot, page manifest, per-destination steps, supplier reference, version hashes and idempotency keys |
| RA-45 / RA-169–171 | Private size/checksum validation, multipart page uploads, 201/202 readback, exact reference/ID verification, retained attempt history |
| RA-46 / RA-172–174 | Internal Job Input Materials only, exact supported quantity/cents, tax exclusion, returned material IDs, unsupported precision blocked for review |
| RA-47 / RA-175–177 | Receipt/destination serialization, all-page/all-line completion, partial-success projection, retention only on verified full export |
| RA-48 / RA-178–180 | Read-before-retry, immutable successes, bounded attempts, uncertain-result fencing, separate correction proposals, audited admin manual handoff |
| RA-49 / RA-181–183 | Contract/failure injection tests, exact amounts/routing checks, scoped live upload/material/replay/append verification |

The database uses one immutable receipt approval envelope with distinct per-job/page/line steps. This preserves the requested per-destination behavior without duplicating the receipt's approval snapshot. An empty readback after an uncertain dispatch does **not** authorize retry: this is deliberately stricter than the early RA-178 shorthand. The unsupported-precision policy follows the user's explicit decision.

## Final checks

| Check | Result |
| --- | --- |
| Workspace unit suites | 685 tests: 6 monitoring, 111 mobile, 295 web, 170 domain, 103 integration |
| Type checks | All four workspaces and RA-6 acceptance scripts |
| Repository lint | Passed, 345 files |
| Web production build | Passed with local configuration and external credentials disabled |
| Browser suite | 35 passed, including admin manual-handoff confirmation and closed-state messaging |
| Retained local browser acceptance | Supported multipage approval and actual manual-handoff display passed |
| Synthetic fixture verifier | All arithmetic, image hashes/provenance and blocked scenarios passed |
| Database migrations | 28 migrations applied to the isolated clean verification database; retained test runtime upgraded without reset |
| Applied SQL | All 12 rollback-only suites passed, including manual-resolution races/evidence/RLS and scoped synchronization |
| Concurrency | Real overlapping database sessions cannot steal receipt/job destination leases |
| Supabase security advisors | No error-level findings |
| Live Housecall | Four successful synthetic receipts; 20 total writes including the retained precision mismatch, 19 exact verified steps, zero replay writes |
| Final controls | Zero active grants, uncertain steps or locks; general reads/exports disabled |

The original verification database contains retained synthetic acceptance records. The additional clean database on port 55422 runs rollback-only suites; neither is the existing development database on 54322. Housecall reads used only customer-filtered lists and exact approved test-job paths. All writes used frozen payload/hash allowlists, one-dispatch transport journals and bounded local grants.

No user input remains necessary for RA-6's implemented test scope. Full-business activation, hosted migrations/deployment, automatic replacement/deletion of existing costs, broader supplier accuracy work and an overhead allocation feature are separate decisions. None is silently enabled by closing this epic.
