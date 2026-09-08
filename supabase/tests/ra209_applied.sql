-- RA-209 applied-schema and privilege checks. Read-only and rollback-safe.

begin;

do $$
declare
  snapshot record;
begin
  if not exists (
    select 1 from pg_roles
    where rolname = 'svl_storage_monitor'
      and (not rolcanlogin or current_setting('svl.test_allow_monitor_login', true) = 'true')
      and not rolsuper
      and not rolbypassrls
      and not rolcreatedb
      and not rolcreaterole
  ) then
    raise exception 'svl_storage_monitor must be restricted, with NOLOGIN unless hosted monitor login is explicitly allowed';
  end if;

  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join lateral unnest(coalesce(p.proconfig, '{}'::text[])) as setting(value)
    where n.nspname = 'svl_ops'
      and p.proname = 'storage_capacity_snapshot'
      and p.prosecdef
      and setting.value in ('search_path=', 'search_path=""')
  ) then
    raise exception 'storage snapshot must be SECURITY DEFINER with an empty search_path';
  end if;

  if has_schema_privilege('public', 'svl_ops', 'USAGE')
    or has_schema_privilege('anon', 'svl_ops', 'USAGE')
    or has_schema_privilege('authenticated', 'svl_ops', 'USAGE')
    or has_schema_privilege('service_role', 'svl_ops', 'USAGE') then
    raise exception 'application roles must not access the operational schema';
  end if;

  if has_function_privilege('public', 'svl_ops.storage_capacity_snapshot()', 'EXECUTE')
    or has_function_privilege('anon', 'svl_ops.storage_capacity_snapshot()', 'EXECUTE')
    or has_function_privilege('authenticated', 'svl_ops.storage_capacity_snapshot()', 'EXECUTE')
    or has_function_privilege('service_role', 'svl_ops.storage_capacity_snapshot()', 'EXECUTE')
    or not has_function_privilege('svl_storage_monitor', 'svl_ops.storage_capacity_snapshot()', 'EXECUTE') then
    raise exception 'storage snapshot execution boundary is incorrect';
  end if;

  if has_table_privilege('svl_storage_monitor', 'storage.objects', 'SELECT')
    or has_table_privilege('svl_storage_monitor', 'public.receipt_pages', 'SELECT') then
    raise exception 'monitor must not read object or receipt rows directly';
  end if;

  select * into snapshot from svl_ops.storage_capacity_snapshot();
  if snapshot.storage_bytes < 0
    or snapshot.object_count < 0
    or snapshot.average_object_bytes < 0
    or snapshot.confirmed_page_bytes < 0
    or snapshot.confirmed_page_count < 0
    or snapshot.average_confirmed_page_bytes < 0
    or snapshot.confirmed_receipt_count < 0
    or snapshot.average_confirmed_receipt_bytes < 0 then
    raise exception 'storage snapshot values must be nonnegative';
  end if;
end;
$$;

rollback;
