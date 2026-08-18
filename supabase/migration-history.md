# Git vs live migration history (RA-208)

Git is the source of truth for schema. Live projects recorded split MCP names with different timestamps. Do not rewrite already-applied SQL files.

## Git files

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

## Live MCP names

Each live project records split names such as `foundation_hardening` / `p1`–`p7`, `blocker_remediation_p1`–`p6`, `trigger_queue_applied_fixes_p1`–`p3`. Those rows stay. After the repair below, Git versions are also marked applied so `supabase db push` will only apply **newer** Git files.

## Repair (run once per live project)

Insert Git versions that are not already in `supabase_migrations.schema_migrations`. Do not delete live split rows.

```sql
insert into supabase_migrations.schema_migrations (version, name)
select v.version, v.name
from (values
  ('20260813180000', 'profiles_and_authz'),
  ('20260814120000', 'receipt_core_schema'),
  ('20260814140000', 'housecall_export_schema'),
  ('20260814160000', 'transition_guards'),
  ('20260814180000', 'receipts_storage_private'),
  ('20260814190000', 'audit_work_outbox'),
  ('20260814200000', 'retention_lifecycle'),
  ('20260814210000', 'foundation_hardening'),
  ('20260818161945', 'blocker_remediation'),
  ('20260818173115', 'trigger_queue_applied_fixes'),
  ('20260818183938', 'persistable_work_and_hold_recovery')
) as v(version, name)
where not exists (
  select 1 from supabase_migrations.schema_migrations m where m.version = v.version
);
```

A clean local database is created by applying the Git files in order (`supabase db reset` once CLI config exists). Do not use `db push` to replay the files above against a database that already has the live split history unless this repair has been applied.
