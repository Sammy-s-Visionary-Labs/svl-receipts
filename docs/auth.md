# Authentication (RA-15)

Sign-in, sessions, and roles. **Do not put secret values in this file.**

Roles live in `public.profiles` (`worker` | `manager` | `admin`, plus `disabled`). The API never trusts a role sent by the client.

## Apply the database

In each Supabase project (dev, then prod):

1. **SQL Editor** → paste and run `supabase/migrations/20260813180000_profiles_and_authz.sql`.
2. **Authentication → Providers**: Email on. Disable public signup if the dashboard offers that toggle.
3. Create users under **Authentication → Users**. New rows get `profiles.role = worker`.
4. Promote a user in SQL (service role / dashboard), for example:

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

`proxy.ts` only refreshes cookies and sends anonymous browsers to `/login`. **Authorization is enforced in route handlers** (`lib/auth/guards.ts`).

Local web: copy `.env.example` to `apps/web/.env.local` with **dev** values. Local mobile: `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` (same publishable/anon key as web).

## Routes

| Method | Path | Who |
| --- | --- | --- |
| GET | `/api/me` | any active user |
| POST | `/api/auth/sign-out` | signed-in user (add `?all=1` to revoke every device) |
| GET | `/api/manager/queue` | manager, admin |
| GET | `/api/admin/users` | admin |
| GET | `/api/receipts/[id]` | owner, or manager/admin |

Denied API responses look like `{ "error": { "code": "unauthenticated" \| "forbidden", "message": "..." } }` and do not include receipt contents. Denials are logged as `[authz-denied]` with user id and route only.

`receipts` is a thin table (`id`, `owner_user_id`) so ownership guards can be proven. RA-16 expands it into the full receipt schema.
