# Tooling (RA-74)

| Concern | Choice |
| --- | --- |
| Lint + format | Biome |
| Lint policy | Errors fail (`npm run lint` exits non-zero) |
| Tests | Vitest in `@svl/domain` and `@svl/mobile` session store |
| Node | 22+ (`engines.node`, Vercel 22.x, CI) |
| Supabase CLI | Pinned dev dependency; local PostgreSQL 17 from `supabase/config.toml` |
| Commands | `npm run typecheck`, `npm run lint`, `npm test`, `npm run build:web`, `npm run test:applied`, `npm run db:start`, `npm run db:reset`, `npm run db:stop`, `npm run format` |

Config: `biome.json` at repo root. Domain tests: `packages/domain` (`vitest.config.ts`).
