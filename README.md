# SVL Receipts

Internal receipt capture → office review → Housecall Job Inputs.

This is a **monorepo**: one Git repo with multiple packages that make up one product.

## Packages

| Path | Name | Purpose |
| --- | --- | --- |
| `apps/mobile` | `@svl/mobile` | Expo app for field workers |
| `apps/web` | `@svl/web` | Next.js manager dashboard + API |
| `packages/domain` | `@svl/domain` | Shared business types (RA-75 contracts) |
| `packages/integrations` | `@svl/integrations` | Housecall / vision adapters |

Read [docs/boundaries.md](docs/boundaries.md) before adding cross-package imports.
Read [docs/tooling.md](docs/tooling.md) for lint/test command choices.
Read [docs/domain-contracts.md](docs/domain-contracts.md) for shared `@svl/domain` types (RA-75).
Read [docs/auth.md](docs/auth.md) for sign-in, roles, and API guards (RA-15).
Read [docs/architecture.md](docs/architecture.md) for retention, processing, storage, and API-mutation decisions (2026-08-14).
Read [docs/environments.md](docs/environments.md) for Vercel/Supabase setup, owners, rotation, quota checks, and retention/backup expiration (RA-19).
Read [supabase/migration-history.md](supabase/migration-history.md) before linking the CLI or changing either hosted database (RA-208).

## Requirements

- Node.js 22+
- npm 10+ (workspaces)
- Docker-compatible runtime for local Supabase migration checks

## Setup

```bash
npm install
```

## How to check your work

After a clean install, these must succeed:

```bash
npm run typecheck   # TypeScript across all packages (does not require a Next build)
npm run lint        # Biome lint + format check (errors fail the command)
npm test            # Vitest (@svl/domain contracts + helpers, mobile session store)
npm run build:web   # Next.js production build
npm run test:applied  # Executes supabase/tests/ra2_applied.sql (needs SVL_APPLIED_DATABASE_URL)
```

Optional:

```bash
npm run format      # Apply Biome formatting
```

## Dev commands

```bash
npm run dev:web       # Next.js manager app
npm run dev:mobile    # Expo phone app
npm run build:web     # Production build for web
npm run db:start      # Start the minimal local Supabase/PostgreSQL 17 stack
npm run db:reset      # Recreate the local DB from every Git migration
npm run db:stop       # Stop and discard the local stack
```

## Tooling choices

| Concern | Choice |
| --- | --- |
| Lint + format | Biome (strict: errors fail `npm run lint`) |
| Unit tests | Vitest in `@svl/domain` |
| Package manager | npm workspaces |
| Domain contracts | See `docs/domain-contracts.md` |

## Environment

Copy `.env.example` into `apps/web/.env.local` (gitignored) using **dev** values only. Never commit secrets. Housecall, AI, Supabase service-role, and `CRON_SECRET` stay server-only.

For Expo, set `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` to the same **dev** public values.

Cloud mapping, owners, rotation, and free-tier quota checks: [docs/environments.md](docs/environments.md).
