-- RA-43: job reads are staged and committed only after a complete bounded scan.
alter table public.manager_job_catalog
 add column source text,
 add column synced_at timestamptz,
 add column provider_updated_at timestamptz,
 add column unavailable boolean not null default false,
 add column customer_id text,
 add column assigned_employee_ids jsonb not null default '[]';
create index manager_job_catalog_synced_idx on public.manager_job_catalog(source,synced_at);

create table public.housecall_sync_state (
 id boolean primary key default true check(id),
 last_success_at timestamptz, last_full_sync_at timestamptz,
 lease_token uuid, lease_expires_at timestamptz,
 last_error text, last_count integer not null default 0
);
insert into public.housecall_sync_state(id) values(true);
alter table public.housecall_sync_state enable row level security;
revoke all on public.housecall_sync_state from public,anon,authenticated;
grant all on public.housecall_sync_state to service_role;

create table public.housecall_employee_mappings (
 employee_id text primary key check(employee_id ~ '^[A-Za-z0-9_-]{1,160}$'),
 user_id uuid not null references public.profiles(id),
 updated_by uuid not null references public.profiles(id),
 updated_at timestamptz not null default now()
);
create index housecall_employee_mapping_user_idx on public.housecall_employee_mappings(user_id);
alter table public.housecall_employee_mappings enable row level security;
revoke all on public.housecall_employee_mappings from public,anon,authenticated;
grant all on public.housecall_employee_mappings to service_role;

create function public.claim_housecall_job_sync(p_lease_seconds integer default 180)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare s public.housecall_sync_state%rowtype;
begin
 if p_lease_seconds is null or p_lease_seconds not between 30 and 300 then raise exception 'invalid_request'; end if;
 update public.housecall_sync_state set lease_token=gen_random_uuid(),
  lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds)
 where id and (lease_expires_at is null or lease_expires_at<=clock_timestamp()) returning * into s;
 if not found then return null; end if;
 return to_jsonb(s);
end $$;

create function public.finish_housecall_job_sync(p_lease_token uuid,p_started_at timestamptz,p_jobs jsonb,p_full boolean,p_observed_job_ids text[] default null)
returns integer language plpgsql security invoker set search_path='' as $$
declare s public.housecall_sync_state%rowtype; j jsonb; n integer;
begin
 select * into s from public.housecall_sync_state where id for update;
 if p_lease_token is null or s.lease_token is distinct from p_lease_token or s.lease_expires_at<=clock_timestamp() then raise exception 'conflict'; end if;
 if p_started_at is null or p_started_at>clock_timestamp()+interval '1 minute' or p_started_at<clock_timestamp()-interval '10 minutes'
  or p_full is null or p_jobs is null or jsonb_typeof(p_jobs)<>'array' or jsonb_array_length(p_jobs)>10000 then raise exception 'invalid_request'; end if;
 if exists(select 1 from jsonb_array_elements(p_jobs) a group by a->>'id' having count(*)>1) then raise exception 'invalid_request'; end if;
 if p_observed_job_ids is not null and (cardinality(p_observed_job_ids)>10000
  or exists(select 1 from unnest(p_observed_job_ids) v where v is null or v !~ '^[A-Za-z0-9_-]{1,160}$')
  or exists(select 1 from jsonb_array_elements(p_jobs) a where not(a->>'id'=any(p_observed_job_ids)))) then raise exception 'invalid_request'; end if;
 for j in select * from jsonb_array_elements(p_jobs) loop
  if jsonb_typeof(j->'id') is distinct from 'string' or coalesce(j->>'id','') !~ '^[A-Za-z0-9_-]{1,160}$'
   or jsonb_typeof(j->'label') is distinct from 'string' or btrim(coalesce(j->>'label',''))='' or length(j->>'label')>1000
   or jsonb_typeof(j->'active') is distinct from 'boolean' or jsonb_typeof(j->'unavailable') is distinct from 'boolean'
   or jsonb_typeof(j->'assigned_employee_ids') is distinct from 'array' then raise exception 'invalid_request'; end if;
  if exists(select 1 from jsonb_array_elements(j->'assigned_employee_ids') e where jsonb_typeof(e) is distinct from 'string'
   or (e#>>'{}') !~ '^[A-Za-z0-9_-]{1,160}$') then raise exception 'invalid_request'; end if;
  insert into public.manager_job_catalog(id,label,customer,job_number,status,scheduled_at,technicians,active,
   service_address,source,synced_at,provider_updated_at,unavailable,customer_id,assigned_employee_ids,assigned_worker_ids,updated_at)
  values(j->>'id',j->>'label',j->>'customer',j->>'job_number',j->>'status',(j->>'scheduled_at')::timestamptz,
   j->'assigned_employee_ids',(j->>'active')::boolean,j->>'service_address','housecall',p_started_at,
   (j->>'provider_updated_at')::timestamptz,(j->>'unavailable')::boolean,j->>'customer_id',j->'assigned_employee_ids',
   coalesce((select jsonb_agg(distinct m.user_id::text) from public.housecall_employee_mappings m join public.profiles p on p.id=m.user_id
    where not p.disabled and j->'assigned_employee_ids' ? m.employee_id),'[]'::jsonb),clock_timestamp())
  on conflict(id) do update set label=excluded.label,customer=excluded.customer,job_number=excluded.job_number,
   status=excluded.status,scheduled_at=excluded.scheduled_at,technicians=excluded.technicians,active=excluded.active,
   service_address=excluded.service_address,source=excluded.source,synced_at=excluded.synced_at,
   provider_updated_at=excluded.provider_updated_at,unavailable=excluded.unavailable,customer_id=excluded.customer_id,
   assigned_employee_ids=excluded.assigned_employee_ids,assigned_worker_ids=excluded.assigned_worker_ids,updated_at=excluded.updated_at;
 end loop;
 if p_observed_job_ids is not null then
  update public.manager_job_catalog set synced_at=p_started_at where source='housecall' and id=any(p_observed_job_ids);
 end if;
 if p_full then
  update public.manager_job_catalog set unavailable=true,active=false
   where source='housecall' and not exists(select 1 from jsonb_array_elements(p_jobs) present_job where present_job->>'id'=manager_job_catalog.id);
 end if;
 n=jsonb_array_length(p_jobs);
 update public.housecall_sync_state set last_success_at=p_started_at,
  last_full_sync_at=case when p_full then p_started_at else last_full_sync_at end,
  lease_token=null,lease_expires_at=null,last_error=null,last_count=n where id;
 return n;
end $$;

create function public.fail_housecall_job_sync(p_lease_token uuid,p_reason text)
returns void language plpgsql security invoker set search_path='' as $$
begin
 update public.housecall_sync_state set lease_token=null,lease_expires_at=null,
 last_error=case when p_reason in ('provider_authentication_failed','provider_rate_limited','provider_timeout','provider_invalid_response','sync_page_limit','sync_deadline') then p_reason else 'sync_failed' end
 where id and lease_token=p_lease_token;
end $$;

create function public.configure_housecall_employee_mapping(p_actor_id uuid,p_employee_id text,p_user_id uuid)
returns void language plpgsql security invoker set search_path='' as $$
begin
 perform public.require_active_actor(p_actor_id,array['admin']);
 if p_employee_id is null or p_employee_id !~ '^[A-Za-z0-9_-]{1,160}$'
  or not exists(select 1 from public.profiles where id=p_user_id and not disabled) then raise exception 'invalid_request'; end if;
 insert into public.housecall_employee_mappings(employee_id,user_id,updated_by) values(p_employee_id,p_user_id,p_actor_id)
 on conflict(employee_id) do update set user_id=excluded.user_id,updated_by=excluded.updated_by,updated_at=clock_timestamp();
 update public.manager_job_catalog j set assigned_worker_ids=coalesce((select jsonb_agg(distinct m.user_id::text)
  from public.housecall_employee_mappings m join public.profiles p on p.id=m.user_id
  where not p.disabled and j.assigned_employee_ids ? m.employee_id),'[]'::jsonb)
 where source='housecall';
end $$;

revoke all on function public.claim_housecall_job_sync(integer) from public,anon,authenticated;
revoke all on function public.finish_housecall_job_sync(uuid,timestamptz,jsonb,boolean,text[]) from public,anon,authenticated;
revoke all on function public.fail_housecall_job_sync(uuid,text) from public,anon,authenticated;
revoke all on function public.configure_housecall_employee_mapping(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.claim_housecall_job_sync(integer),public.finish_housecall_job_sync(uuid,timestamptz,jsonb,boolean,text[]),
 public.fail_housecall_job_sync(uuid,text),public.configure_housecall_employee_mapping(uuid,text,uuid) to service_role;
