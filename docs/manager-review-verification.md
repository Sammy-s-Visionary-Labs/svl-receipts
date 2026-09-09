# RA-4 verification — 2026-09-07

For hosted development and Preview verification performed on September 8, including real test-account permissions, persistent review decisions and SQL test portability fixes, see [the development acceptance record](manager-review-acceptance-2026-09-08.md). Marci's acceptance remains pending.

## Executed checks

- Full automated suite: **362 tests** across storage capacity (6), mobile (111), web (98), domain (139), and integrations (8).
- **30 Playwright browser scenarios**, including the original 17 queue scenarios and 13 full-review scenarios. New coverage includes versioned drafts, stale/network failures preserving edits, decimal/job validation, N-lines/M-jobs approval and tax acknowledgement, job overwrite confirmation, material focus, signed-image recovery, required reasons, canonical duplicates, read-only history, exact failed-step retry, administrator correction impact, desktop/narrow layouts, keyboard pan, persistent approval actions, and real server guard denials.
- TypeScript checks for all four workspaces and repository Biome lint.
- Next.js production build.
- Clean PostgreSQL 17 replay of **21 migrations**, including the new RA-4 migration; all rollback-only applied suites (RA-2, RA-23, RA-25, RA-209, RA-27 and RA-4).
- RA-4 applied SQL verifies actor roles, disabled accounts, immutable extraction, review/extraction concurrency checks, invalid approval rollback, deterministic fractional rounding, tax/reference exclusion, multi-job intent atomicity, no duplicate approval, non-exporting decisions, required canonical linkage, retention start, exact retry identity, already-succeeded retry rejection, correction permissions, immutable posted state, history job search, final assignments, timeline pagination and purge removal/denial.
- Local Supabase advisors: no errors and no warnings on newly introduced objects. Existing foundation warnings were unchanged (13 warnings at the warning/error levels).
- Desktop 1512×982 and narrow 390×844 browser screenshots inspected. The desktop form/image scroll independently; persistent approval actions remain in the viewport. Narrow review has no horizontal page overflow.
- `git diff --check`.

## Test boundaries

Browser fixtures use synthetic receipts/jobs and a local Auth HTTP fixture. Production auth code verifies fixture sessions and profile roles; manager screen data is intercepted for deterministic UI behavior. API unit tests separately exercise the real route handlers, and the SQL suites execute actual database transactions/permissions. No production authentication bypass was added.

The 30 browser scenarios and SQL transaction checks do not establish live Housecall contract correctness, notification delivery, real extraction accuracy, or a measured one-minute human review time. RA-5/RA-6 supply the live providers, catalog synchronization and recovery consumer described in [manager-review.md](manager-review.md). Recovery commands remain pending until that consumer runs. Hosted migration/deployment remains a separate rollout step.

## Reproduce

```sh
npm ci
npm test
npm run typecheck
npm run lint
npm run build:web
npx playwright install --with-deps chromium
npm run test:e2e
npm run db:start
npm run db:reset
SVL_APPLIED_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm run test:applied
npm run db:stop
```

Run the build and browser development server sequentially because they share Next.js build artifacts. Database tests create their own synthetic data and roll it back.
