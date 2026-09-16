create table public.email_importer_health (
 singleton boolean primary key default true check(singleton),
 last_contact_at timestamptz not null default now()
);
alter table public.email_importer_health enable row level security;
revoke all on public.email_importer_health from public,anon,authenticated;
grant select on public.email_importer_health to authenticated;
grant all on public.email_importer_health to service_role;
create policy email_health_staff on public.email_importer_health for select to authenticated
 using((select public.current_user_role()) in ('manager','admin') and (select public.caller_is_active()));
