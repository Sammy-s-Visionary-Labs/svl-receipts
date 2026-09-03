# Authentication (RA-15)

Sign-in, sessions, and roles. **Do not put secret values in this file.**

Roles live in `public.profiles` (`worker` | `manager` | `admin`, plus `disabled`). The API never trusts a role sent by the client.

## Apply the database

Do not paste migration files into the SQL Editor. That bypasses normal CLI tracking and caused the
split migration history described in [the RA-208 runbook](../supabase/migration-history.md).

- For a clean local database, run `npm run db:start`, `npm run db:reset`, and
  `SVL_APPLIED_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm run test:applied`
  before `npm run db:stop`.
- For the existing dev and production projects, follow the runbook's exact dev-first history repair,
  dry-run, push, schema comparison, and rollback-only applied test. The next pending migration is
  `20260819180000_device_push_tokens.sql`; apply it normally with `db push`, never by marking
  unapplied SQL as applied.
- After the history is reconciled, create every database change with a new forward migration and
  deploy it through the same reviewed `db push` workflow.

Then configure users:

1. **Authentication → Providers**: Email on. Disable public signup if the dashboard offers that toggle.
2. Create users under **Authentication → Users**. New rows get `profiles.role = worker`.
3. Promote a user in SQL (service role / dashboard), for example:

```sql
update public.profiles
set role = 'manager' -- or 'admin'
where id = '<auth user uuid>';
```

Disable without deleting:

```sql
update public.profiles
set disabled = true
where id = '<auth user uuid>';
```

A disabled profile cannot pass `/api/me` even if a cookie or refresh token still exists.
`/api/me` returns `account_inactive` for a missing or disabled profile and `unauthenticated`
for an invalid or revoked session. The mobile shell keeps those states distinct: inactive users
contact their manager, while revoked sessions are sent through the sign-in-again recovery screen.

## Clients

| Client | Session storage | How it calls the API |
| --- | --- | --- |
| Next.js (`apps/web`) | HttpOnly cookies via `@supabase/ssr` | Same-origin cookies |
| Expo (`apps/mobile`) | `expo-secure-store` (chunked; web falls back to localStorage) | `Authorization: Bearer <access_token>` |

`proxy.ts` refreshes cookies and sends anonymous browsers to `/login`. **API routes also accept `Authorization: Bearer`** (mobile + cron). **Authorization is enforced in route handlers** (`lib/auth/guards.ts`) except cron routes, which check `CRON_SECRET`.

### Lifecycle mutations (approved 2026-08-14)

Receipt lifecycle changes go only through authenticated Next.js APIs and trusted workers using server-side `service_role`. Web and mobile clients never receive the service-role key.

`anon` and `authenticated` must not have `INSERT` / `UPDATE` / `DELETE` / `TRUNCATE` on lifecycle tables, and must not execute privileged mutation RPCs (`PUBLIC` included in those revokes). Workers may keep RLS-protected **reads** of their own profile and history. RLS stays enabled as defense in depth, including active-profile checks on remaining owner read policies.

Privileged RPCs (`create_upload_pending_receipt`, `submit_confirmed_receipt`, `create_upload_pending_receipt_set`, `submit_confirmed_receipt_set`, `approve_receipt_with_outbox`, `set_retention_hold`, `claim_work`, `defer_work`, `fail_work`, `claim_abandoned_upload`, `delete_abandoned_upload`, `assert_purge_eligible`, `release_purge_claim`, `purge_receipt_content`, `upsert_device_push_token`) take `p_actor_id` / `p_worker_id` / `p_user_id` from the API or runner and are executable by `service_role` only. GET `/api/receipts/[id]` returns `retentionStartedAt` (column `retention_started_at`).

Integration tests must prove `anon`, workers, and disabled users cannot mutate tables or privileged RPCs directly. `npm test` checks that `supabase/tests/ra2_applied.sql` covers those RPCs. Execute the rollback-only test through `npm run test:applied` with `SVL_APPLIED_DATABASE_URL` set to the reviewed target; do not paste it into the SQL editor. See [architecture.md](architecture.md).

Local web: copy `.env.example` to `apps/web/.env.local` with **dev** values. Local mobile: `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` (same publishable/anon key as web), plus `EXPO_PUBLIC_API_URL` when the phone cannot use `http://<expo-host>:3000`. Optional `EXPO_PUBLIC_PROJECT_ID` (EAS) and `EXPO_PUBLIC_SUPPORT_EMAIL`.

## Routes

| Method | Path | Who |
| --- | --- | --- |
| GET | `/api/me` | any active user |
| POST | `/api/me/push-token` | worker (stores Expo `ExponentPushToken[...]`, `ExpoPushToken[...]`, or UUID token for RA-25; body `token` + `platform`; user id always from the session) |
| GET | `/api/me/receipts` | worker (latest 25 caller-owned confirmed uploads and normalized readability results) |
| POST | `/api/auth/sign-out` | signed-in user (add `?all=1` to revoke every device) |
| GET | `/api/manager/queue` | manager, admin |
| GET | `/api/manager/dead-letters` | manager, admin |
| GET | `/api/admin/users` | admin |
| GET | `/api/receipts/[id]` | owner, or manager/admin |
| GET | `/api/receipts/[id]/events` | owner, or manager/admin |
| POST | `/api/upload-sessions` | any active user (creates or resumes one idempotent receipt and returns per-page signed uploads) |
| POST | `/api/receipts/[id]/confirm` | owner (idempotent; verifies the exact full page set, types, sizes, and SHA-256 checksums; enqueues readability work once) |
| POST | `/api/upload-events` | owner (allowlisted receipt-ID-correlated timing/result metrics only) |
| POST | `/api/receipts/[id]/approve` | manager, admin (review + intent + outbox in one transaction) |
| POST | `/api/receipts/[id]/retention-hold` | manager, admin (hold requires owner + reason) |
| GET | `/api/receipts/[id]/image` | owner, or manager/admin (short-lived signed URL) |
| GET/POST | `/api/cron/abandoned-uploads` | Vercel cron (`Authorization: Bearer CRON_SECRET`) |
| GET/POST | `/api/cron/work` | Vercel cron (`Authorization: Bearer CRON_SECRET`) |

Denied API responses look like `{ "error": { "code": "unauthenticated" \| "account_inactive" \| "forbidden" \| "invalid_request" \| "not_found" \| "conflict" \| "internal", "message": "..." } }` and do not include receipt image bytes. Denials are logged as `[authz-denied]` with user id and route only. Image reads are logged as `[receipt-image-access]` with user id and receipt id only.

`receipts` is the core document (status, page-1 compatibility pointer, optional GPS, retention dates). `receipt_pages` is the authoritative ordered 1..5 object manifest and is read-only to authenticated clients under receipt ownership RLS. Related tables: append-only `readability_checks`, immutable `extractions`, append-only `reviews`, `receipt_lines` (integer cents), `job_candidates`, `housecall_intents`, `housecall_links`, append-only `export_attempts`, append-only `audit_events`, leased `work_items`, and `housecall_outbox`. Confirming an upload queues readability work once, then schedules an idempotent capped worker after the response. The authenticated recovery route handles missed kicks and retries; the Vercel Hobby deployment schedules it daily, and Preview verification invokes it manually. Readable results queue the later extract stage. Approving a receipt writes the review, intent, and outbox in one transaction, then kicks export. Receipt and Housecall-step transition guards live in `@svl/domain` (`evaluateReceiptTransition`, `evaluateHousecallStepAttempt`); a unique index blocks a second succeeded export attempt for the same step target. Bearer `POST /api/auth/sign-out` uses Auth admin logout so refresh tokens are revoked.
