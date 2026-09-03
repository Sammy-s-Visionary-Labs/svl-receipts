-- RA-209: expose aggregate-only Storage capacity metrics to a dedicated monitor role.
-- The role is intentionally NOLOGIN until an operator assigns a unique password per environment.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'svl_storage_monitor') then
    create role svl_storage_monitor nologin nosuperuser nocreatedb nocreaterole noinherit;
  end if;
end;
$$;

create schema if not exists svl_ops;
revoke all on schema svl_ops from public, anon, authenticated, service_role;

create or replace function svl_ops.storage_capacity_snapshot()
returns table (
  storage_bytes bigint,
  object_count bigint,
  average_object_bytes numeric,
  confirmed_page_bytes bigint,
  confirmed_page_count bigint,
  average_confirmed_page_bytes numeric,
  confirmed_receipt_count bigint,
  average_confirmed_receipt_bytes numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  with stored_objects as (
    select case
      when o.metadata ->> 'size' ~ '^[0-9]+$' then (o.metadata ->> 'size')::bigint
      else 0::bigint
    end as byte_size
    from storage.objects as o
    where o.bucket_id = 'receipts'
  ),
  confirmed_pages as (
    select p.receipt_id, p.byte_size::bigint as byte_size
    from public.receipt_pages as p
    where p.confirmed_at is not null
      and p.byte_size is not null
  ),
  receipt_totals as (
    select p.receipt_id, sum(p.byte_size)::bigint as byte_size
    from confirmed_pages as p
    group by p.receipt_id
  )
  select
    coalesce((select sum(o.byte_size) from stored_objects as o), 0)::bigint,
    (select count(*) from stored_objects)::bigint,
    coalesce((select avg(o.byte_size) from stored_objects as o), 0)::numeric,
    coalesce((select sum(p.byte_size) from confirmed_pages as p), 0)::bigint,
    (select count(*) from confirmed_pages)::bigint,
    coalesce((select avg(p.byte_size) from confirmed_pages as p), 0)::numeric,
    (select count(*) from receipt_totals)::bigint,
    coalesce((select avg(r.byte_size) from receipt_totals as r), 0)::numeric;
$$;

revoke all on function svl_ops.storage_capacity_snapshot() from public, anon, authenticated, service_role;
grant usage on schema svl_ops to svl_storage_monitor;
grant execute on function svl_ops.storage_capacity_snapshot() to svl_storage_monitor;
grant connect on database postgres to svl_storage_monitor;

comment on schema svl_ops is
  'Private operational functions. Never expose this schema through the Data API.';
comment on function svl_ops.storage_capacity_snapshot() is
  'RA-209 aggregate-only receipt Storage and confirmed-receipt size snapshot.';
