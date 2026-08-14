# Authentication (RA-15)

Sign-in, sessions, and roles. **Do not put secret values in this file.**

Roles live in `public.profiles` (`worker` | `manager` | `admin`, plus `disabled`). The API never trusts a role sent by the client.

## Apply the database

In each Supabase project (dev, then prod):

1. **SQL Editor** → paste and run `supabase/migrations/20260813180000_profiles_and_authz.sql` (skip if already applied).
2. **SQL Editor** → paste and run `supabase/migrations/20260814120000_receipt_core_schema.sql` (skip if already applied).
3. **SQL Editor** → paste and run `supabase/migrations/20260814140000_housecall_export_schema.sql` (skip if already applied).
4. **SQL Editor** → paste and run `supabase/migrations/20260814160000_transition_guards.sql` (skip if already applied).
5. **SQL Editor** → paste and run `supabase/migrations/20260814180000_receipts_storage_private.sql` (skip if already applied).
6. **SQL Editor** → paste and run `supabase/migrations/20260814190000_audit_work_outbox.sql` (skip if already applied).
7. **SQL Editor** → paste and run `supabase/migrations/20260814200000_retention_lifecycle.sql` (skip if already applied).
8. **Authentication → Providers**: Email on. Disable public signup if the dashboard offers that toggle.
9. Create users under **Authentication → Users**. New rows get `profiles.role = worker`.
10. Promote a user in SQL (service role / dashboard), for example:

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

## Clients

| Client | Session storage | How it calls the API |
| --- | --- | --- |
| Next.js (`apps/web`) | HttpOnly cookies via `@supabase/ssr` | Same-origin cookies |
| Expo (`apps/mobile`) | `expo-secure-store` (chunked; web falls back to localStorage) | `Authorization: Bearer <access_token>` |

`proxy.ts` refreshes cookies and sends anonymous browsers to `/login`. **API routes also accept `Authorization: Bearer`** (mobile + cron). **Authorization is enforced in route handlers** (`lib/auth/guards.ts`) except cron routes, which check `CRON_SECRET`.

Local web: copy `.env.example` to `apps/web/.env.local` with **dev** values. Local mobile: `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` (same publishable/anon key as web).

## Routes

| Method | Path | Who |
| --- | --- | --- |
| GET | `/api/me` | any active user |
| POST | `/api/auth/sign-out` | signed-in user (add `?all=1` to revoke every device) |
| GET | `/api/manager/queue` | manager, admin |
| GET | `/api/manager/dead-letters` | manager, admin |
| GET | `/api/admin/users` | admin |
| GET | `/api/receipts/[id]` | owner, or manager/admin |
| GET | `/api/receipts/[id]/events` | owner, or manager/admin |
| POST | `/api/upload-sessions` | any active user (creates `upload_pending` receipt + signed upload) |
| POST | `/api/receipts/[id]/confirm` | owner (idempotent; verifies object, type, size, checksum; enqueues extract work once) |
| POST | `/api/receipts/[id]/approve` | manager, admin (review + intent + outbox in one transaction) |
| POST | `/api/receipts/[id]/retention-hold` | manager, admin (hold requires owner + reason) |
| GET | `/api/receipts/[id]/image` | owner, or manager/admin (short-lived signed URL) |
| GET/POST | `/api/cron/abandoned-uploads` | Vercel cron (`Authorization: Bearer CRON_SECRET`) |
| GET/POST | `/api/cron/work` | Vercel cron (`Authorization: Bearer CRON_SECRET`) |

Denied API responses look like `{ "error": { "code": "unauthenticated" \| "forbidden" \| "invalid_request" \| "not_found" \| "conflict" \| "internal", "message": "..." } }` and do not include receipt image bytes. Denials are logged as `[authz-denied]` with user id and route only. Image reads are logged as `[receipt-image-access]` with user id and receipt id only.

`receipts` is the core document (status, storage key/metadata, optional GPS, retention dates). Related tables: immutable `extractions`, append-only `reviews`, `receipt_lines` (integer cents), `job_candidates`, `housecall_intents`, `housecall_links`, append-only `export_attempts`, append-only `audit_events`, leased `work_items`, and `housecall_outbox`. Confirming an upload schedules extract work exactly once. Approving a receipt writes the review, intent, and outbox in one transaction. Receipt and Housecall-step transition guards live in `@svl/domain` (`evaluateReceiptTransition`, `evaluateHousecallStepAttempt`); a unique index blocks a second succeeded export attempt for the same step target.
