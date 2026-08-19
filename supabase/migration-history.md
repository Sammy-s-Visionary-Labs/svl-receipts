# Git vs live migration history (RA-208)

Git is the schema source of truth. This runbook reconciles the two hosted projects without replaying old SQL or changing application data.

**Current state (verified 2026-08-18): reconciliation is complete.** Dev and production each record the same 12 canonical Git migrations through `20260818191408_ra2_audit_and_replay_fixes.sql`. The 27 project-specific split versions were removed from migration metadata in each project, dev first and then production. The final migration was applied normally with `db push`; it was not marked applied through repair. Ordinary forward `db push` is the supported deployment path again.

The commands below are retained as the completed operator record. **Do not rerun the historical repair commands.** `supabase migration repair --status reverted` changed only `supabase_migrations.schema_migrations`; it did not undo DDL or delete application data.

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
| 20260818191408 | `ra2_audit_and_replay_fixes` |

Both live projects record every version in this table. Do not mark any of them applied again and never rewrite their SQL files.

`20260818191408_ra2_audit_and_replay_fixes.sql` was applied normally to dev and then production after the split-history repair. Never mark a future unapplied migration `applied` merely to silence a history mismatch.

## Completed reconciliation evidence

Operator session: 2026-08-18. Branch head used for the database repair was `946d316`; Supabase CLI was `2.115.0`; Node was `v22.14.0`.

The following evidence passed before and after the dev-first repair:

1. A clean PostgreSQL 17 database was rebuilt entirely from Git and passed the applied test:

   ```bash
   npm run db:start
   npm run db:reset
   SVL_APPLIED_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm run test:applied
   npm run db:stop
   ```

   CI run `32179289333` performed the same clean reset and test successfully.

2. The repair was metadata-only and performed by one operator. Both hosted projects remained `ACTIVE_HEALTHY`. Supabase Free has no PITR; that recovery limitation remains documented in `docs/environments.md`.

3. The clean Git result was compared with each target. After the normal forward push, the applied SQL suite exited successfully, the private bucket/RLS/grants were rechecked, and exact leftover receipt/work/audit/object counts were zero. Post-push `db diff` reported only known function-body formatting noise, not extra tables or columns.

4. No `db reset --linked`, `db push --include-all`, `db push --include-seed`, SQL Editor paste, or repair-marking of `20260818191408` as applied was used.

## Completed dev repair — `svl-receipts-dev`

Project ref: `vrtcbrowjnipbldoioyr`.

The pre-repair list contained the 11 canonical baseline versions plus the 27 obsolete dev split rows below, with `20260818191408` still local-only. The following historical commands were run once and must not be rerun:

```bash
npx supabase migration list --project-ref vrtcbrowjnipbldoioyr
```

The 27 obsolete dev split rows were removed from migration metadata with:

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

The post-repair list showed only the canonical baseline, and the dry run showed only the intentional forward migration:

```bash
npx supabase migration list --project-ref vrtcbrowjnipbldoioyr
npx supabase db push --dry-run --project-ref vrtcbrowjnipbldoioyr
```

The reviewed migration was then applied normally:

```bash
npx supabase db push --project-ref vrtcbrowjnipbldoioyr
```

The final dev list contained all 12 canonical versions and no split versions. `db diff`, the applied test, bucket/RLS/grant checks, and zero-leftover checks completed before production work began.

## Completed production repair — `svl-receipts-prod`

Project ref: `ouyhvzvtjntbtxpmeeyj`.

After dev passed, the production pre-repair list contained the 11 canonical baseline versions plus the 27 obsolete production split rows below, with `20260818191408` still local-only. The following historical commands were run once and must not be rerun:

```bash
npx supabase migration list --project-ref ouyhvzvtjntbtxpmeeyj
```

The 27 obsolete production split rows were removed from migration metadata with:

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

The post-repair history and dry run were checked before applying anything:

```bash
npx supabase migration list --project-ref ouyhvzvtjntbtxpmeeyj
npx supabase db push --dry-run --project-ref ouyhvzvtjntbtxpmeeyj
```

The dry run contained only the same forward migration already validated on dev. It was applied normally, never with `migration repair --status applied`:

```bash
npx supabase db push --project-ref ouyhvzvtjntbtxpmeeyj
```

MCP confirmed the final production history contains all 12 canonical versions and no split versions. The applied test exited successfully, bucket/RLS/grants remained correct, and exact leftover counts were zero. A CLI `migration list` attempt hung during login-role initialization and was killed; that produced authentication log noise but did not roll back or alter the successfully applied schema. The Jira RA-208 operator log preserves the before/after evidence.

## Rule for future history drift

- If migration SQL has **not** run remotely, apply it normally with `db push`; do not mark it applied.
- If identical SQL was already applied under temporary split versions, first prove clean replay and final-schema equivalence. Then mark the canonical Git version applied, and only afterward mark the mapped split rows reverted.
- Never infer equivalence from similar migration names. Preserve the before/after history and schema evidence.
- Reconcile dev first. Production follows only after the exact forward migration and checks succeed on dev.
