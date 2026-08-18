# Git vs live migration history (RA-208)

Git is the schema source of truth. This runbook reconciles the two hosted projects without replaying old SQL or changing application data.

**Current state (verified 2026-08-18): reconciliation is not complete.** The live baseline has 11 canonical migrations through `20260818183938`; Git also contains the pending forward migration `20260818191408`. Each live project has the 11 baseline versions **plus 27 project-specific split versions** created while the same changes were applied through MCP. Merely adding the canonical rows did not make those extra rows safe: Supabase CLI compares migration timestamps, so the remote-only rows must be removed from migration metadata before `db push` becomes the normal deployment path.

`supabase migration repair --status reverted` changes only `supabase_migrations.schema_migrations`; it does not undo DDL or delete application data. It is safe here only after the clean-replay, schema-equivalence, grants, and applied tests below succeed.

## Canonical Git baseline

| Version | File |
| --- | --- |
| 20260813180000 | `profiles_and_authz` |
| 20260814120000 | `receipt_core_schema` |
| 20260814140000 | `housecall_export_schema` |
| 20260814160000 | `transition_guards` |
| 20260814180000 | `receipts_storage_private` |
| 20260814190000 | `audit_work_outbox` |
| 20260814200000 | `retention_lifecycle` |
| 20260814210000 | `foundation_hardening` |
| 20260818161945 | `blocker_remediation` |
| 20260818173115 | `trigger_queue_applied_fixes` |
| 20260818183938 | `persistable_work_and_hold_recovery` |

Both live projects already record every version in this table. Do not mark any of them applied again and never rewrite their SQL files.

`20260818191408_ra2_audit_and_replay_fixes.sql` is the next ordinary forward migration. It is **not** part of the split-history repair. After the old history is reconciled, apply it normally to dev with `db push`, validate dev, and then repeat on production. Never mark an unapplied migration `applied` merely to silence a history mismatch.

## Required evidence before repairing either remote

Use the pinned CLI from this repository (`npm ci`; then `npx supabase ...`). Docker must be running.

1. Prove a clean PostgreSQL 17 database can be rebuilt entirely from Git and passes the applied test:

   ```bash
   npm run db:start
   npm run db:reset
   SVL_APPLIED_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm run test:applied
   npm run db:stop
   ```

   CI performs the same clean reset and test. A failed or skipped database job blocks reconciliation.

2. Take a current backup or confirm the platform backup/recovery plan for the target project. Although repair is metadata-only, a mistaken history repair can make a later push run the wrong SQL.

3. Compare the clean Git migration result with the target remote:

   ```bash
   npx supabase db diff --project-ref PROJECT_REF --schema public
   ```

   Because the clean replay includes the still-pending `20260818191408` migration, the only expected difference is its reviewed audit/recovery and bucket-replay delta. Any other DDL is unexplained and blocks repair. `db diff` has known blind spots for publications, Storage bucket configuration, and some view attributes, so also compare the current-baseline private bucket, RLS, table grants, function grants, triggers, and constraints directly. Do **not** run the expanded applied test against the target yet: it requires `20260818191408` and therefore runs only after the history repair and normal forward push.

4. Freeze schema changes and deployments until the target's repair, forward push, and post-checks are finished. Never use `db reset --linked`, `db push --include-all`, or `db push --include-seed` on either hosted project.

## Dev repair — `svl-receipts-dev`

Project ref: `vrtcbrowjnipbldoioyr`.

First capture the pre-repair list and confirm that all 11 canonical versions above are present:

```bash
npx supabase migration list --project-ref vrtcbrowjnipbldoioyr
```

After all prerequisite evidence is green, remove only the 27 obsolete dev split rows from migration metadata:

```bash
npx supabase migration repair \
  20260814162024 \
  20260814164339 \
  20260814164418 \
  20260814164436 \
  20260814164503 \
  20260814164528 \
  20260814164559 \
  20260814164639 \
  20260814183429 \
  20260814183511 \
  20260814183531 \
  20260814183551 \
  20260814183613 \
  20260814183632 \
  20260814183659 \
  20260814183742 \
  20260818162554 \
  20260818162602 \
  20260818162617 \
  20260818162640 \
  20260818162712 \
  20260818162727 \
  20260818173605 \
  20260818173616 \
  20260818173641 \
  20260818184802 \
  20260818184846 \
  --status reverted \
  --project-ref vrtcbrowjnipbldoioyr
```

Then verify history and preview the one intentional forward migration:

```bash
npx supabase migration list --project-ref vrtcbrowjnipbldoioyr
npx supabase db push --dry-run --project-ref vrtcbrowjnipbldoioyr
```

The list must show the canonical baseline aligned. The dry run must show only `20260818191408_ra2_audit_and_replay_fixes.sql` (or intentional migrations added after it). Review that SQL, then apply it normally:

```bash
npx supabase db push --project-ref vrtcbrowjnipbldoioyr
```

Repeat `migration list`, `db diff`, and the applied test against dev. Do not continue to production unless dev is clean.

## Production repair — `svl-receipts-prod`

Project ref: `ouyhvzvtjntbtxpmeeyj`.

Use a maintenance window, re-check the backup/recovery plan, and confirm no deploy or schema work is running. Capture the pre-repair list and confirm all 11 canonical versions are present:

```bash
npx supabase migration list --project-ref ouyhvzvtjntbtxpmeeyj
```

After dev has passed every post-check, remove only the 27 obsolete production split rows from migration metadata:

```bash
npx supabase migration repair \
  20260814162026 \
  20260814164649 \
  20260814164716 \
  20260814164738 \
  20260814164802 \
  20260814164825 \
  20260814164851 \
  20260814164901 \
  20260814183802 \
  20260814183842 \
  20260814183902 \
  20260814183927 \
  20260814183947 \
  20260814184004 \
  20260814184030 \
  20260814184038 \
  20260818162835 \
  20260818162842 \
  20260818162855 \
  20260818162917 \
  20260818162944 \
  20260818162959 \
  20260818173834 \
  20260818173844 \
  20260818173907 \
  20260818184802 \
  20260818184845 \
  --status reverted \
  --project-ref ouyhvzvtjntbtxpmeeyj
```

Verify and dry-run before applying anything:

```bash
npx supabase migration list --project-ref ouyhvzvtjntbtxpmeeyj
npx supabase db push --dry-run --project-ref ouyhvzvtjntbtxpmeeyj
```

The dry run must contain only the same forward migration already validated on dev. Apply it normally, never with `migration repair --status applied`:

```bash
npx supabase db push --project-ref ouyhvzvtjntbtxpmeeyj
```

Repeat `migration list`, `db diff`, and the rollback-only applied test against production. Archive the before/after lists, dry-run output, diff result, applied-test output, operator, and timestamp as RA-208 evidence.

## Rule for future history drift

- If migration SQL has **not** run remotely, apply it normally with `db push`; do not mark it applied.
- If identical SQL was already applied under temporary split versions, first prove clean replay and final-schema equivalence. Then mark the canonical Git version applied, and only afterward mark the mapped split rows reverted.
- Never infer equivalence from similar migration names. Preserve the before/after history and schema evidence.
- Reconcile dev first. Production follows only after the exact forward migration and checks succeed on dev.
