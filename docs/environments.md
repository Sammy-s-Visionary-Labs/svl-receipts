# Environments (RA-78)

How to find each cloud resource, which env var names exist, how to rotate credentials, and where to check free-tier usage.

**Do not put secret values in this file, git, Slack, or Jira.** Keys live in the team vault and in Vercel project settings.

## How the pieces connect

There is **one GitHub repo** and **one Vercel project**. There are **two Supabase projects**.

- Git branch `master` → Vercel **Production** → **prod** Supabase
- Any other git branch → Vercel **Preview** → **dev** Supabase
- Laptop (`apps/web/.env.local`) → **dev** Supabase only

Vercel Hobby. No Railway worker.

## Matrix

| Resource | Non-prod | Production |
| --- | --- | --- |
| GitHub | [Sammy-s-Visionary-Labs/svl-receipts](https://github.com/Sammy-s-Visionary-Labs/svl-receipts) | same repo |
| Git branch | any branch except `master` (including `epic/RA-2-platform-identity-data`) | `master` |
| Vercel project | same project as Production (the one imported from this GitHub repo) | same |
| Vercel environment checkboxes | Preview + Development | Production |
| Vercel URL | the Preview URL for that branch (`*.vercel.app`) | the **stable Production domain** in the Vercel project header (not a per-deploy hash URL) |
| Next.js app / Root Directory | `apps/web` | `apps/web` |
| Node | 20.x | 20.x |
| Supabase project name | `svl-receipts-dev` | `svl-receipts-prod` |
| Storage bucket | `receipts` (private; public access off) | `receipts` (private; public access off) |
| Vault entry | `svl-receipts-dev` | `svl-receipts-prod` |

If a dashboard name differs, update this table. Do not invent a second Vercel project for Expo.

### Open the dashboards

**Vercel**

1. [https://vercel.com/dashboard](https://vercel.com/dashboard)
2. Switch to the company team (not a personal account, unless that *is* the company account).
3. Open the project connected to `Sammy-s-Visionary-Labs/svl-receipts`.
4. Confirm **Settings → General → Root Directory** is `apps/web`.
5. Confirm **Settings → Git → Production Branch** is `master`.
6. Production URL: project overview, domain marked **Production**.
7. Env vars: **Settings → Environment Variables**.

**Supabase**

1. [https://supabase.com/dashboard](https://supabase.com/dashboard)
2. Switch to the company org.
3. Open `svl-receipts-dev` or `svl-receipts-prod` (two separate projects).
4. Keys: **Project Settings → API Keys**.
5. Auth URLs: **Authentication → URL Configuration**.
6. Storage: **Storage → `receipts`**. The bucket must stay **private**. Clients read and write only through short-lived signed URLs from the API.

## Environment variables

Names are listed in [`.env.example`](../.env.example). Values are not.

Set them in Vercel → **Settings → Environment Variables**. The same **name** is added twice when Production and Preview values differ: one row with **Production** checked, one row with **Preview** and **Development** checked.

| Name | Client or server | Production | Preview + Development | Sensitive |
| --- | --- | --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Client-safe | prod project URL | dev project URL | No |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Client-safe (publishable / legacy anon) | prod publishable/anon | dev publishable/anon | No |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only (secret / legacy service_role) | prod secret | dev secret | Yes |
| `HOUSECALL_API_KEY` | Server-only | prod Housecall key | sandbox or dummy | Yes |
| `AI_PROVIDER` | Server-only | provider name (`gemini` / `openai`) | test provider | No |
| `AI_API_KEY` | Server-only | prod AI key | sandbox or dummy | Yes |
| `CRON_SECRET` | Server-only (Vercel cron auth for abandoned-upload cleanup and the work runner) | unique 16+ char string | a **different** unique string | Yes |

Rules:

- Only `NEXT_PUBLIC_*` may appear in the browser bundle. Changing those requires a **redeploy**.
- Never prefix Housecall, AI, service-role, or `CRON_SECRET` with `NEXT_PUBLIC_`.
- Preview must not use prod Supabase keys.
- After any env change, redeploy the matching environment (`master` for Production, the feature branch for Preview).

### Local laptop

1. Copy `.env.example` to `apps/web/.env.local` (gitignored).
2. Fill **dev** values from the vault.
3. Never point local env at prod.

## Ownership

| Resource | Owner | Who can rotate keys |
| --- | --- | --- |
| Vercel team / project | Purshottam Singh (RA-14 assignee) | Same, plus anyone with Vercel admin on the company team |
| Supabase org / both projects | Purshottam Singh | Same, plus anyone with Supabase org admin |
| Vault entries `svl-receipts-dev` / `svl-receipts-prod` | Purshottam Singh | Same |
| Housecall API key | Purshottam Singh | Same |
| AI provider key | Purshottam Singh | Same |

Update this table when ownership changes.

## Rotate credentials

Do not put the new value in this file. Vault first, then Vercel, then redeploy, then disable the old key.

### Supabase publishable/anon or secret key

1. Supabase dashboard → the environment’s project (`svl-receipts-dev` or `svl-receipts-prod`).
2. **Project Settings → API Keys**.
3. Create or roll the key.
4. Store the new value in the vault under that environment’s entry.
5. Vercel → **Settings → Environment Variables** → edit `NEXT_PUBLIC_SUPABASE_ANON_KEY` or `SUPABASE_SERVICE_ROLE_KEY`.
6. Paste into the correct checkboxes only (Production vs Preview+Development).
7. Redeploy: `master` if Production changed; a Preview branch if Preview changed. `NEXT_PUBLIC_*` is baked in at build time.
8. After the new deploy is live, disable or delete the old key in Supabase.

If the **project URL** ever changes, also update `NEXT_PUBLIC_SUPABASE_URL` and Auth **Site URL** / **Redirect URLs**.

### Housecall or AI key

1. Rotate in that vendor’s dashboard.
2. Vault, then Vercel (`HOUSECALL_API_KEY` or `AI_API_KEY`), correct environment checkboxes, redeploy.
3. Revoke the old vendor key.

### `CRON_SECRET`

1. Generate a new random string, at least 16 characters.
2. Vault, then Vercel, correct environment, redeploy.
3. Production and Preview must stay different strings.

## Quota checks (Hobby / free tier)

Check **both** Supabase projects. They do not share one quota.

### Vercel Hobby

1. [https://vercel.com/dashboard](https://vercel.com/dashboard) → company team.
2. Team **Settings → Billing** / **Usage**.
3. Look at deployments, bandwidth, and function invocations.
4. Cron jobs: Hobby allows **two cron jobs**, each **at most once per day**. Daily cron is **recovery** (missed/stale work, abandoned-upload cleanup, due purges, retries). Primary extract/export kicks happen immediately after upload confirmation and after approval. See [architecture.md](architecture.md). A schedule more frequent than daily will fail the deploy. There is no always-on worker.

### Supabase free

1. Open `svl-receipts-dev`, then repeat for `svl-receipts-prod`.
2. **Project Settings → Usage** (or **Billing / Reports** if the UI uses that name).
3. Look at database size, storage, Auth MAUs, and Edge Function invocations if those are enabled.
4. Free projects can **pause** after inactivity. Production should not sit unused if the office depends on it; a paused project has to be restored before the app works.

## Receipt retention and backups (RA-19 / RA-66)

Approved policy is in [architecture.md](architecture.md). The 365-day clock starts only when **every** Housecall attachment and Job Input target on the **current** intent succeeds, or when the receipt is **declined** (`rejected`, `rejected_unreadable`, or `duplicate`). Partial export does not start the clock. `failed` does not start the clock. `retention_started_at` is set once; `delete_after_at = retention_started_at + 365 days`. Exhausted export retries do not start retention; a manager **export abandoned** action may send the receipt back for correction or decline/close it.

Never-submitted receipts have no start event. A manager/admin hold (owner + reason) skips deletion. The database must not record a purge until Storage object removal has succeeded.

**Pilot Storage (1 GB, both projects).** Keep Free-tier Storage for now. Add client-side resize/compression before upload, usage and average-size monitoring, and alerts at 70% / 85% / 95% of quota on **both** `svl-receipts-dev` and `svl-receipts-prod`. Prefer buying more managed storage over self-hosting if usage requires it.

**Backup expiration is a release risk.** Supabase Free has **no PITR**. If the project has automatic backups, deleted receipt content can remain until those backups expire — app-level purge is not the same as backup expiration. Before a production retention go-live, check **Project Settings → Add-ons / Backups** on both projects. If PITR is ever enabled, record its recovery window here.

## Auth URLs (allowed origins)

After a Vercel URL exists:

- **Dev Supabase** (`svl-receipts-dev`): **Authentication → URL Configuration**. Site URL / redirect URLs include the Preview host and `http://localhost:3000/**` as needed.
- **Prod Supabase** (`svl-receipts-prod`): Site URL and redirect URLs use the **stable Production domain** only. Do not allow every `*.vercel.app` preview host on prod.

## Drift check

Configuration drift is visible when these disagree:

- Vercel Production `NEXT_PUBLIC_SUPABASE_URL` vs the `svl-receipts-prod` project URL
- Vercel Preview `NEXT_PUBLIC_SUPABASE_URL` vs the `svl-receipts-dev` project URL
- This file’s project names vs the live dashboards
- `.env.example` names vs Vercel variable names

If they disagree, update Vercel or this file — do not leave a silent mismatch.
