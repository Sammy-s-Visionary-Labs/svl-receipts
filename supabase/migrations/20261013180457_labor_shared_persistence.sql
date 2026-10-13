-- Labor has its own shared ledger. This migration does not alter receipt, user,
-- payroll-source, job-catalog or Housecall records and grants no provider write authority.
create table public.labor_state (
 singleton boolean primary key default true check(singleton),
 revision bigint not null default 0 check(revision between 0 and 9007199254740991),
 control jsonb check(control is null or (jsonb_typeof(control)='object' and not control ?| array['imports','notesImports'])),
 updated_at timestamptz not null default now()
);
insert into public.labor_state(singleton) values(true);

create table public.labor_source_imports (
 id uuid primary key,
 kind text not null check(kind in ('timesheet','notes')),
 position integer not null check(position>=0),
 active boolean not null default true,
 file_sha256 text not null check(file_sha256 ~ '^[a-f0-9]{64}$'),
 content_hash text not null check(content_hash ~ '^[a-f0-9]{64}$'),
 summary jsonb not null check(jsonb_typeof(summary)='object' and not summary ?| array['id','hash','report']),
 report jsonb check(report is null or jsonb_typeof(report)='object'),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index labor_source_active_order_idx on public.labor_source_imports(kind,position) where active;

create table public.labor_control_events (
 id uuid primary key default gen_random_uuid(),
 revision bigint not null,
 actor_id uuid references public.profiles(id),
 changed_keys text[] not null,
 details jsonb not null check(jsonb_typeof(details)='object'),
 created_at timestamptz not null default now()
);
create index labor_control_events_actor_idx on public.labor_control_events(actor_id);
create index labor_control_events_revision_idx on public.labor_control_events(revision);

-- The session table only identifies encrypted objects. No user-facing role can read it.
create table public.labor_worker_sessions (
 singleton boolean primary key default true check(singleton),
 version bigint not null default 0 check(version between 0 and 9007199254740991),
 object_key text check(object_key ~ '^[a-f0-9-]{36}\.bin$'),
 content_sha256 text check(content_sha256 ~ '^[a-f0-9]{64}$'),
 updated_at timestamptz not null default now(),
 check((object_key is null)=(content_sha256 is null))
);
insert into public.labor_worker_sessions(singleton) values(true);

alter table public.labor_state enable row level security;
alter table public.labor_source_imports enable row level security;
alter table public.labor_control_events enable row level security;
alter table public.labor_worker_sessions enable row level security;
revoke all on public.labor_state,public.labor_source_imports,public.labor_control_events,public.labor_worker_sessions from public,anon,authenticated,service_role;
grant select on public.labor_state,public.labor_source_imports,public.labor_control_events to authenticated;
grant select,insert,update on public.labor_state,public.labor_source_imports,public.labor_worker_sessions to service_role;
grant select,insert on public.labor_control_events to service_role;
create policy labor_state_staff_read on public.labor_state for select to authenticated
 using((select public.current_user_role()) in ('manager','admin') and (select public.caller_is_active()));
create policy labor_imports_staff_read on public.labor_source_imports for select to authenticated
 using((select public.current_user_role()) in ('manager','admin') and (select public.caller_is_active()));
create policy labor_events_staff_read on public.labor_control_events for select to authenticated
 using((select public.current_user_role()) in ('manager','admin') and (select public.caller_is_active()));

create function public.reject_labor_event_mutation() returns trigger
language plpgsql security invoker set search_path='' as $$
begin raise exception 'labor_audit_is_immutable' using errcode='42501'; end;
$$;
revoke all on function public.reject_labor_event_mutation() from public,anon,authenticated,service_role;
create trigger labor_events_insert_only before update or delete on public.labor_control_events
 for each row execute function public.reject_labor_event_mutation();

-- One statement snapshot makes control, import ordinals and report contents consistent.
-- The optional revision allows trusted server caches to skip unchanged report transfers.
create function public.read_labor_state(p_known_revision bigint default null) returns jsonb
language sql stable security invoker set search_path='' as $$
 select case when s.control is null then null
  when s.revision=p_known_revision then jsonb_build_object('revision',s.revision,'unchanged',true)
  else jsonb_build_object('revision',s.revision,
   'state',s.control || jsonb_build_object(
    'imports',coalesce((select jsonb_agg(i.summary || jsonb_build_object('id',i.id,'hash',i.file_sha256)
      || case when i.report is null then '{}'::jsonb else jsonb_build_object('report',i.report) end order by i.position)
      from public.labor_source_imports i where i.active and i.kind='timesheet'),'[]'::jsonb),
    'notesImports',coalesce((select jsonb_agg(i.summary || jsonb_build_object('id',i.id,'hash',i.file_sha256)
      || case when i.report is null then '{}'::jsonb else jsonb_build_object('report',i.report) end order by i.position)
      from public.labor_source_imports i where i.active and i.kind='notes'),'[]'::jsonb)),
   'manifest',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'kind',i.kind,'position',i.position,'content_hash',i.content_hash) order by i.kind,i.position)
     from public.labor_source_imports i where i.active),'[]'::jsonb)) end
 from public.labor_state s where s.singleton;
$$;

create function public.read_labor_state_manifest() returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('revision',s.revision,
  'manifest',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'kind',i.kind,'position',i.position,'content_hash',i.content_hash) order by i.kind,i.position)
    from public.labor_source_imports i where i.active),'[]'::jsonb))
 from public.labor_state s where s.singleton;
$$;

create function public.compare_and_swap_labor_state(
 p_expected_revision bigint,p_control jsonb,p_manifest jsonb,p_changed_imports jsonb,p_actor_id uuid default null
) returns bigint language plpgsql security invoker set search_path='' as $$
declare
 current_state public.labor_state%rowtype;
 item jsonb;
 next_revision bigint;
 previous_config jsonb;
 next_config jsonb;
 changed_keys text[];
 source_changed boolean;
begin
 if p_expected_revision is null or p_expected_revision<0
  or p_control is null or jsonb_typeof(p_control)<>'object'
  or p_control ?| array['imports','notesImports'] or pg_column_size(p_control)>1048576
  or p_manifest is null or jsonb_typeof(p_manifest)<>'array' or jsonb_array_length(p_manifest)>10000
  or p_changed_imports is null or jsonb_typeof(p_changed_imports)<>'array'
  or jsonb_array_length(p_changed_imports)>jsonb_array_length(p_manifest)
 then raise exception 'invalid_labor_state' using errcode='22023'; end if;
 if p_actor_id is not null then perform public.require_active_actor(p_actor_id,array['manager','admin']); end if;
 select * into current_state from public.labor_state where singleton for update;
 if not found then raise exception 'labor_state_unavailable'; end if;
 if current_state.revision<>p_expected_revision then return null; end if;
 if current_state.revision>=9007199254740991 then raise exception 'labor_revision_limit'; end if;
 next_revision:=current_state.revision+1;

 -- Validate the complete manifest, including unique IDs and ordinal coverage per kind.
 if exists(select 1 from jsonb_array_elements(p_manifest) m where
  jsonb_typeof(m)<>'object' or m->>'id' is null or (m->>'id') !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  or m->>'kind' is null or m->>'kind' not in ('timesheet','notes')
  or m->>'position' is null or (m->>'position') !~ '^[0-9]{1,9}$'
  or m->>'content_hash' is null or (m->>'content_hash') !~ '^[a-f0-9]{64}$')
  or (select count(*)<>count(distinct m->>'id') from jsonb_array_elements(p_manifest) m)
  or exists(select 1 from jsonb_array_elements(p_manifest) m group by m->>'kind'
    having min((m->>'position')::integer)<>0 or max((m->>'position')::integer)<>count(*)-1
      or count(distinct (m->>'position')::integer)<>count(*))
 then raise exception 'invalid_labor_manifest' using errcode='22023'; end if;
 if (select count(*)<>count(distinct m->>'id') from jsonb_array_elements(p_changed_imports) m)
 then raise exception 'invalid_labor_sources' using errcode='22023'; end if;

 source_changed:=exists(select 1 from public.labor_source_imports i where i.active
  and not exists(select 1 from jsonb_array_elements(p_manifest) m where (m->>'id')::uuid=i.id))
  or exists(select 1 from jsonb_array_elements(p_manifest) m left join public.labor_source_imports i on i.id=(m->>'id')::uuid
   where i.id is null or not i.active or i.kind<>m->>'kind' or i.position<>(m->>'position')::integer or i.content_hash<>m->>'content_hash');
 for item in select value from jsonb_array_elements(p_changed_imports) loop
  if jsonb_typeof(item)<>'object' or jsonb_typeof(item->'summary') is distinct from 'object'
   or item->'summary' ?| array['id','hash','report'] or pg_column_size(item->'summary')>524288
   or (item->'report'<>'null'::jsonb and jsonb_typeof(item->'report') is distinct from 'object')
   or pg_column_size(item->'report')>33554432
   or item->>'file_sha256' is null or (item->>'file_sha256') !~ '^[a-f0-9]{64}$'
   or not exists(select 1 from jsonb_array_elements(p_manifest) m where m->>'id'=item->>'id'
      and m->>'kind'=item->>'kind' and m->>'content_hash'=item->>'content_hash'
      and m->>'position'=item->>'position')
  then raise exception 'invalid_labor_sources' using errcode='22023'; end if;
  if exists(select 1 from public.labor_source_imports i where i.id=(item->>'id')::uuid
   and (i.kind<>item->>'kind' or i.file_sha256<>item->>'file_sha256'))
  then raise exception 'labor_source_identity_changed' using errcode='22023'; end if;
  insert into public.labor_source_imports(id,kind,position,active,file_sha256,content_hash,summary,report)
  values((item->>'id')::uuid,item->>'kind',(item->>'position')::integer,true,item->>'file_sha256',item->>'content_hash',item->'summary',nullif(item->'report','null'::jsonb))
  on conflict(id) do update set position=excluded.position,active=true,content_hash=excluded.content_hash,
   summary=excluded.summary,report=excluded.report,updated_at=clock_timestamp()
  where public.labor_source_imports.content_hash is distinct from excluded.content_hash or not public.labor_source_imports.active;
 end loop;
 -- A delta can omit an unchanged record only when the exact active content already exists.
 if exists(select 1 from jsonb_array_elements(p_manifest) m left join public.labor_source_imports i on i.id=(m->>'id')::uuid
  where i.id is null or not i.active or i.kind<>m->>'kind' or i.content_hash<>m->>'content_hash')
 then raise exception 'labor_source_delta_incomplete' using errcode='22023'; end if;
 update public.labor_source_imports i set position=(m->>'position')::integer,updated_at=clock_timestamp()
 from jsonb_array_elements(p_manifest) m where i.id=(m->>'id')::uuid and i.position<>(m->>'position')::integer;
 -- Omitted parsed snapshots lose only their rebuildable JSON; originals and import provenance stay.
 update public.labor_source_imports i set active=false,report=null,updated_at=clock_timestamp()
 where i.active and not exists(select 1 from jsonb_array_elements(p_manifest) m where (m->>'id')::uuid=i.id);

 -- Operational sync noise is persisted but does not emit a control audit on every heartbeat.
 -- Lease credentials and renewals never enter audit payloads, even on initialization/import events.
 previous_config:=coalesce(current_state.control,'{}'::jsonb)-array['sync','workerLease','lastScheduledDate'] || jsonb_build_object('sync',
  coalesce(current_state.control->'sync','{}'::jsonb)-array['status','lastAttemptAt','lastSuccessAt','nextRunAt','lastError','workerHeartbeatAt']);
 next_config:=p_control-array['sync','workerLease','lastScheduledDate'] || jsonb_build_object('sync',coalesce(p_control->'sync','{}'::jsonb)
  -array['status','lastAttemptAt','lastSuccessAt','nextRunAt','lastError','workerHeartbeatAt']);
 select coalesce(array_agg(k order by k),'{}'::text[]) into changed_keys
 from (select jsonb_object_keys(previous_config || next_config) k) keys
 where previous_config->k is distinct from next_config->k;
 if source_changed then changed_keys:=array_append(changed_keys,'sources'); end if;
 update public.labor_state set control=p_control,revision=next_revision,updated_at=clock_timestamp() where singleton;
 if cardinality(changed_keys)>0 then
  insert into public.labor_control_events(revision,actor_id,changed_keys,details)
  values(next_revision,p_actor_id,changed_keys,jsonb_build_object('previousControl',previous_config,
    'resultingControl',next_config,'sourcesChanged',source_changed,
    'activeTimesheets',(select count(*) from jsonb_array_elements(p_manifest) m where m->>'kind'='timesheet'),
    'activeNotes',(select count(*) from jsonb_array_elements(p_manifest) m where m->>'kind'='notes')));
 end if;
 return next_revision;
end;
$$;

create function public.compare_and_swap_labor_worker_session(
 p_expected_version bigint,p_object_key text,p_content_sha256 text
) returns bigint language plpgsql security invoker set search_path='' as $$
declare current_version bigint;
begin
 if p_expected_version is null or p_expected_version<0 or p_object_key is null
  or p_object_key !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.bin$'
  or p_content_sha256 is null or p_content_sha256 !~ '^[a-f0-9]{64}$'
 then raise exception 'invalid_labor_worker_session' using errcode='22023'; end if;
 select version into current_version from public.labor_worker_sessions where singleton for update;
 if not found then raise exception 'labor_worker_session_unavailable'; end if;
 if current_version<>p_expected_version then return null; end if;
 if current_version>=9007199254740991 then raise exception 'labor_session_version_limit'; end if;
 if not exists(select 1 from storage.objects where bucket_id='labor-worker-sessions' and name=p_object_key)
 then raise exception 'labor_worker_session_upload_missing'; end if;
 update public.labor_worker_sessions set version=current_version+1,object_key=p_object_key,
  content_sha256=p_content_sha256,updated_at=clock_timestamp() where singleton;
 return current_version+1;
end;
$$;

revoke all on function public.read_labor_state(bigint),public.read_labor_state_manifest(),
 public.compare_and_swap_labor_state(bigint,jsonb,jsonb,jsonb,uuid),
 public.compare_and_swap_labor_worker_session(bigint,text,text) from public,anon,authenticated;
grant execute on function public.read_labor_state(bigint),public.read_labor_state_manifest(),
 public.compare_and_swap_labor_state(bigint,jsonb,jsonb,jsonb,uuid),
 public.compare_and_swap_labor_worker_session(bigint,text,text) to service_role;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('labor-originals','labor-originals',false,10485760,array['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']),
 ('labor-worker-sessions','labor-worker-sessions',false,1048576,array['application/octet-stream'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
-- Guard these buckets even if an unrelated permissive storage policy is broadened later.
-- Manager originals are served by the authenticated application endpoint, never public links.
create policy labor_storage_private_guard on storage.objects as restrictive for all to anon,authenticated
 using(bucket_id not in ('labor-originals','labor-worker-sessions'))
 with check(bucket_id not in ('labor-originals','labor-worker-sessions'));

-- Organization/project storage quota includes email and labor objects as well as receipts.
-- Keep the existing aggregate-only monitor contract and confirmed-receipt metrics intact.
create or replace function svl_ops.storage_capacity_snapshot()
returns table(storage_bytes bigint,object_count bigint,average_object_bytes numeric,
 confirmed_page_bytes bigint,confirmed_page_count bigint,average_confirmed_page_bytes numeric,
 confirmed_receipt_count bigint,average_confirmed_receipt_bytes numeric)
language sql stable security definer set search_path='' as $$
 with stored_objects as (
  select case when o.metadata->>'size' ~ '^[0-9]+$' then (o.metadata->>'size')::bigint else 0::bigint end byte_size
  from storage.objects o
 ), confirmed_pages as (
  select p.receipt_id,p.byte_size::bigint byte_size from public.receipt_pages p
  where p.confirmed_at is not null and p.byte_size is not null
 ), receipt_totals as (
  select p.receipt_id,sum(p.byte_size)::bigint byte_size from confirmed_pages p group by p.receipt_id
 )
 select coalesce((select sum(o.byte_size) from stored_objects o),0)::bigint,
  (select count(*) from stored_objects)::bigint,coalesce((select avg(o.byte_size) from stored_objects o),0)::numeric,
  coalesce((select sum(p.byte_size) from confirmed_pages p),0)::bigint,
  (select count(*) from confirmed_pages)::bigint,coalesce((select avg(p.byte_size) from confirmed_pages p),0)::numeric,
  (select count(*) from receipt_totals)::bigint,coalesce((select avg(r.byte_size) from receipt_totals r),0)::numeric;
$$;
revoke all on function svl_ops.storage_capacity_snapshot() from public,anon,authenticated,service_role;
grant execute on function svl_ops.storage_capacity_snapshot() to svl_storage_monitor;
comment on function svl_ops.storage_capacity_snapshot() is
 'Aggregate-only all-bucket Storage quota usage and confirmed-receipt size snapshot.';
