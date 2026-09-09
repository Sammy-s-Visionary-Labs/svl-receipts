# RA-27 queue verification

Verified locally on 2026-09-07 after a clean replay of all migrations including
`20260907154627_ra27_manager_review_queue.sql`.

Final application verification passed: 301 automated tests across the workspaces
and storage monitor, repository lint, TypeScript checks, and the production Next.js
build. The 17 Playwright scenarios passed using Playwright 1.62.1 and its matching
Chromium 1234. After the final typography adjustment, both desktop (1280 px) and
mobile (390 px) visual/overflow checks passed again. Browser fixtures are described
in `apps/web/e2e/README.md`; they exercise the real application auth guards against
a synthetic loopback service and do not substitute for the applied SQL tests.

The local Supabase security/performance advisors reported no errors and no finding
on the new queue function or indexes. Existing warnings concern earlier RLS policy
initialization plans and mutable search paths on older functions; RA-27 does not
change those functions or expand their permissions.

The queue API suite has 26 passing tests covering authorization denials, a role
revoked between the HTTP guard and database call, input validation, bounded pages,
microsecond cursor precision, cursor/filter binding, all query parameters, empty
data, unavailable extraction fields and safe error/response shapes.

`supabase/tests/ra27_applied.sql` runs through the regular `npm run test:applied`
runner. It verifies all six status groups and every filter against PostgreSQL,
latest extraction and sparse review edits, document-level suggestions, confirmed
page counts, current outbox intent selection, superseded export attempts,
cancelled exports, timestamp/UUID pagination, active manager/admin access, worker
and disabled-manager denial, function grants, RLS-preserving execution and indexes.
The fixture is rolled back.

## Indexed page query

An additional rollback-only workload added 10,000 needs-review receipts to the
15-receipt applied fixture and ran `ANALYZE public.receipts`. The queue's inner SQL
was inspected with `EXPLAIN (ANALYZE, BUFFERS)` as the `authenticated` role with the
fixture manager's JWT subject, using the default filter values and a 26-row limit.
The RPC sets `plan_cache_mode = force_custom_plan` so each call can fold its sort
parameters to the indexed timestamp/UUID order.

Relevant final-plan output:

```text
Limit (actual time=0.961..1.419 rows=26 loops=1)
  Index Scan using receipts_manager_queue_order_idx on receipts r
    (actual time=0.050..0.155 rows=26 loops=1)
Planning Time: 1.148 ms
Execution Time: 1.575 ms
```

The plan consumed 26 receipt rows and had no outer queue sort. Evidence lookups
used their existing receipt indexes; current export-attempt lookup used
`export_attempts_intent_target_latest_idx`. Small per-receipt sorts select the
latest evidence deterministically.

This demonstrates the default page access path, not production throughput. The
10,000 additional receipts had no extraction/review/job records, while the small
applied fixture supplied representative evidence. Selective vendor, confidence or
Housecall filters can examine more receipts before finding a page. The measurement
excludes HTTP/authentication/network/thumbnail costs and inspects the inner query
with default parameter constants, not nested RPC timing.

All additional test rows were rolled back. Exact captured query and plan are
available for this local run at `/private/tmp/ra27-manager-queue-explain.sql` and
`/private/tmp/ra27-manager-queue-query-plan.txt`.
