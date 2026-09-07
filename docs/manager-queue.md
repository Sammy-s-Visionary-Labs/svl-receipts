# Manager review queue (RA-27)

The manager home page provides the review queue for active managers and administrators.
Worker accounts cannot load the queue, its database function, or its thumbnails.
Inbox opens Needs review with the oldest submissions first. History opens completed
submissions and provides access to the rejected/duplicate view. Selecting a receipt
opens a read-only summary; the two-pane editing workspace belongs to RA-28 onward.

## Views and data

| Queue tab | Receipt states |
| --- | --- |
| Needs review | `needs_review` |
| Processing | `submitted`, `processing`, `approved`, `exporting` |
| Partial success | `partial_success` |
| Failed | `failed` |
| Completed | `exported` |
| Rejected/Duplicate | `rejected`, `rejected_unreadable`, `duplicate` |

Unconfirmed uploads and receipts whose content has been purged do not appear.
Status filters narrow the selected tab. Search, vendor, submitter, age, UTC submission
dates, extraction confidence, marked-duplicate state, and Housecall status are applied
in the database before pagination. Vendor/search input is a bounded literal substring,
so `%` and `_` do not become wildcard operators.

Rows show the latest extraction, subsequent sparse reviewer header edits, the latest
document-level job suggestion, and current-intent Housecall state. Superseded failed
export attempts do not override newer successful attempts for the same target.

The existing profile schema has no display name. Submitters therefore appear with a
short worker ID, with their full ID available for filtering. A suggestion is labelled
as the latest stored suggestion: the current candidate schema has no rank or score.
Confidence is the minimum valid per-field extraction confidence; below 80% is Low.
Missing confidence is Unavailable, and it is never presented as job-match confidence.
Duplicate filtering means explicitly marked duplicates; automated duplicate detection
belongs to later work. Reference totals are shown as receipt context, not job cost.

The extraction and Housecall providers are separate epics. Receipts awaiting those
providers remain in their real processing states. No sample rows or invented results
are inserted into the application database.

## API and privacy

`GET /api/manager/queue` returns a maximum of 50 rows (25 by default), an opaque
`nextCursor`, normalized filters, and the `asOf` time used for age filtering. The
database fetches one extra row to determine whether another page exists. Ordering
uses submission time and receipt UUID; cursor timestamps retain PostgreSQL
microseconds. A cursor is bound to all filters, sort order and page size. Changing a
filter starts a new page; the browser preserves queue state in its URL.

The `manager_review_queue` function uses `SECURITY INVOKER`, existing row-level
security, and an active manager/admin check. Only `authenticated` may execute it;
the function does not grant workers a path around the API guard. Queue responses
omit image originals, storage keys, raw OCR, manager notes, and credentials.

Thumbnails use `GET /api/manager/receipts/[id]/thumbnail`, which rechecks manager
access and reads only confirmed page 1. Originals are bounded to 10 MiB, decoded
with a pixel/time limit, resized to fit 128 × 160, and returned as metadata-free
JPEGs. The browser loads them lazily. This does not require Supabase paid image
transformations. Queue and thumbnail responses use `Cache-Control: private, no-store`.

## Verification and deployment

From the repository root:

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build:web
npm run db:start
npm run db:reset
SVL_APPLIED_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm run test:applied
npx playwright install chromium
npm run test:e2e
```

`db:reset` is only for the isolated local database. The applied SQL suites are
rollback-only and test actual permissions, data selection, ordering and filters.
The browser suite uses synthetic authentication/queue fixtures on local servers;
it does not contact or seed a hosted project. API/unit tests and the applied SQL
suite cover the server and database paths separately.

Apply `20260907154627_ra27_manager_review_queue.sql` before deploying this web
version. Verify the migration in development first using the established migration
workflow in `supabase/migration-history.md`. Existing migration files are unchanged.
Production rollout and hosted smoke testing are separate from local verification.
