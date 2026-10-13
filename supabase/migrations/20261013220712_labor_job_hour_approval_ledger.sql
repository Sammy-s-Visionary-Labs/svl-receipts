-- Explicit job-hour review and manual-send ledger only. No provider calls, cron,
-- business-data approval seeds, customer mutations or automatic dispatches.
create table public.labor_job_hour_approvals (
 id uuid primary key default gen_random_uuid(),
 snapshot jsonb not null check(jsonb_typeof(snapshot)='object'),
 canonical_snapshot text not null,
 snapshot_hash text not null check(snapshot_hash ~ '^[a-f0-9]{64}$'),
 source_revision bigint not null check(source_revision between 0 and 9007199254740991),
 source_fingerprint text not null check(source_fingerprint ~ '^[a-f0-9]{64}$'),
 status text not null default 'approved' check(status in ('approved','stale','sending','sent','failed','reconciliation_required','revoked')),
 approved_by uuid not null references public.profiles(id),
 approved_at timestamptz not null default clock_timestamp(),
 sent_at timestamptz,
 provider_reference text,
 last_error text,
 check((status='sent')=(sent_at is not null)),
 check(provider_reference is null or length(provider_reference) between 1 and 500)
);
create index labor_hour_approvals_history_idx on public.labor_job_hour_approvals(approved_at desc,id);

create table public.labor_job_hour_attempts (
 id uuid primary key default gen_random_uuid(),
 approval_id uuid not null references public.labor_job_hour_approvals(id),
 actor_id uuid not null references public.profiles(id),
 source_revision bigint not null,
 lease_token uuid not null default gen_random_uuid(),
 status text not null default 'claimed' check(status in ('claimed','dispatched','sent','failed','uncertain')),
 created_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null default clock_timestamp()+interval '2 minutes',
 dispatched_at timestamptz,
 completed_at timestamptz,
 provider_reference text,
 response_hash text check(response_hash is null or response_hash ~ '^[a-f0-9]{64}$'),
 error_code text,
 check(expires_at>created_at)
);
create index labor_hour_attempts_approval_idx on public.labor_job_hour_attempts(approval_id,created_at desc,id);
create unique index labor_hour_attempts_one_live_idx on public.labor_job_hour_attempts(approval_id) where status in ('claimed','dispatched','uncertain');

-- Reservations survive job remaps and replacement XLSX/source IDs. Clock spans
-- use both normalized name and employee ID; either matching identity blocks an
-- overlapping span. Every mutation serializes through labor_state first.
create table public.labor_job_hour_reservations (
 id bigint generated always as identity primary key,
 approval_id uuid not null references public.labor_job_hour_approvals(id),
 source_entry_id text not null,
 worker_name_key text not null,
 employee_id text,
 work_date date not null,
 start_minute integer not null check(start_minute between 0 and 1439),
 end_minute integer not null check(end_minute between 1 and 1439 and end_minute>start_minute),
 released_at timestamptz,
 unique(approval_id,source_entry_id)
);
create index labor_hour_reservations_name_idx on public.labor_job_hour_reservations(work_date,worker_name_key,start_minute,end_minute) where released_at is null;
create index labor_hour_reservations_employee_idx on public.labor_job_hour_reservations(work_date,employee_id,start_minute,end_minute) where released_at is null and employee_id is not null;

create table public.labor_job_hour_events (
 id bigint generated always as identity primary key,
 approval_id uuid not null references public.labor_job_hour_approvals(id),
 attempt_id uuid references public.labor_job_hour_attempts(id),
 actor_id uuid references public.profiles(id),
 event text not null,
 details jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default clock_timestamp()
);
create index labor_hour_events_approval_idx on public.labor_job_hour_events(approval_id,id);
alter table public.labor_job_hour_approvals enable row level security;
alter table public.labor_job_hour_attempts enable row level security;
alter table public.labor_job_hour_reservations enable row level security;
alter table public.labor_job_hour_events enable row level security;
revoke all on public.labor_job_hour_approvals,public.labor_job_hour_attempts,public.labor_job_hour_reservations,public.labor_job_hour_events from public,anon,authenticated,service_role;
grant select,insert,update on public.labor_job_hour_approvals,public.labor_job_hour_attempts,public.labor_job_hour_reservations to service_role;
grant select,insert on public.labor_job_hour_events to service_role;
grant usage,select on sequence public.labor_job_hour_reservations_id_seq,public.labor_job_hour_events_id_seq to service_role;

create function public.labor_approval_worker_key(p_name text) returns text
language sql immutable security invoker set search_path='' as $$
 with parts as (select pg_catalog.regexp_split_to_array(pg_catalog.normalize(p_name,'NFKC'),',') p)
 select pg_catalog.lower(pg_catalog.regexp_replace(pg_catalog.btrim(case when array_length(p,1)=2 then p[2]||' '||p[1] else pg_catalog.normalize(p_name,'NFKC') end),'\s+',' ','g')) from parts;
$$;
create function public.labor_approval_source_fingerprint() returns text
language sql stable security invoker set search_path='' as $$
 select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(jsonb_build_object(
  'control',s.control-array['sync','workerLease','lastScheduledDate','receipts'],
  'sources',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'kind',i.kind,'position',i.position,'hash',i.content_hash) order by i.kind,i.position) from public.labor_source_imports i where i.active),'[]'::jsonb)
 )::text,'UTF8')),'hex') from public.labor_state s where s.singleton;
$$;

create function public.guard_labor_approval_immutability() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if tg_op='DELETE' then raise exception 'labor_approval_immutable' using errcode='42501'; end if;
 if tg_table_name='labor_job_hour_approvals' then
  if old.status='sent' or (to_jsonb(new)-array['status','sent_at','provider_reference','last_error']) is distinct from (to_jsonb(old)-array['status','sent_at','provider_reference','last_error']) then
   raise exception 'labor_approval_immutable' using errcode='42501'; end if;
 elsif tg_table_name='labor_job_hour_attempts' then
  if old.status='sent' or (to_jsonb(new)-array['status','dispatched_at','completed_at','provider_reference','response_hash','error_code']) is distinct from (to_jsonb(old)-array['status','dispatched_at','completed_at','provider_reference','response_hash','error_code'])
   or (old.dispatched_at is not null and new.dispatched_at is distinct from old.dispatched_at) then
   raise exception 'labor_approval_immutable' using errcode='42501'; end if;
 elsif tg_table_name='labor_job_hour_reservations' then
  if (to_jsonb(new)-'released_at') is distinct from (to_jsonb(old)-'released_at') or old.released_at is not null or new.released_at is null
   or exists(select 1 from public.labor_job_hour_approvals a where a.id=old.approval_id and a.status not in ('stale','revoked'))
   or exists(select 1 from public.labor_job_hour_attempts a where a.approval_id=old.approval_id and a.dispatched_at is not null) then
   raise exception 'labor_approval_immutable' using errcode='42501'; end if;
 end if;
 return new;
end; $$;
create trigger labor_hour_approval_immutable before update or delete on public.labor_job_hour_approvals for each row execute function public.guard_labor_approval_immutability();
create trigger labor_hour_attempt_immutable before update or delete on public.labor_job_hour_attempts for each row execute function public.guard_labor_approval_immutability();
create trigger labor_hour_reservation_immutable before update or delete on public.labor_job_hour_reservations for each row execute function public.guard_labor_approval_immutability();
create trigger labor_hour_event_immutable before update or delete on public.labor_job_hour_events for each row execute function public.reject_labor_event_mutation();

create function public.labor_job_hour_approval_record(p_id uuid) returns jsonb
language sql volatile security invoker set search_path='' as $$
 select (to_jsonb(a)-array['canonical_snapshot','source_fingerprint']) || jsonb_build_object(
  'status',case when a.status='sending' and t.expires_at<=clock_timestamp() then case when t.dispatched_at is null then 'failed' else 'reconciliation_required' end else a.status end,
  'last_attempt',case when t.id is null then null else jsonb_build_object('id',t.id,'status',t.status,'source_revision',t.source_revision,'created_at',t.created_at,'expires_at',t.expires_at,'dispatched_at',t.dispatched_at,'completed_at',t.completed_at) end)
 from public.labor_job_hour_approvals a left join lateral(select * from public.labor_job_hour_attempts x where x.approval_id=a.id order by x.created_at desc,x.id desc limit 1)t on true where a.id=p_id;
$$;
create function public.read_labor_job_hour_approvals() returns jsonb
language sql volatile security invoker set search_path='' as $$
 select coalesce(jsonb_agg(public.labor_job_hour_approval_record(a.id) order by a.approved_at desc,a.id),'[]'::jsonb) from public.labor_job_hour_approvals a;
$$;

create function public.approve_labor_job_hours(p_snapshot jsonb,p_canonical text,p_snapshot_hash text,p_source_revision bigint,p_actor_id uuid) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare ledger public.labor_state%rowtype; item jsonb; source jsonb; worker jsonb; source_import public.labor_source_imports%rowtype; saved uuid; fingerprint text; total bigint:=0; st integer; en integer; paid bigint:=0; regular bigint:=0; overtime bigint:=0; cost bigint:=0; cost_source bigint:=0;
begin
 select * into ledger from public.labor_state where singleton for update;
 perform public.require_active_actor(p_actor_id,array['manager','admin']);
 if ledger.control is null or ledger.revision<>p_source_revision or p_source_revision is null then raise exception 'labor_approval_stale'; end if;
 if coalesce((p_snapshot is null or p_canonical is null or p_snapshot_hash is null or p_snapshot_hash !~ '^[a-f0-9]{64}$'
  or length(p_canonical)>4194304 or p_canonical::jsonb is distinct from p_snapshot
  or pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_canonical,'UTF8')),'hex')<>p_snapshot_hash
  or p_snapshot->>'version'<>'1' or p_snapshot->>'hourBasis'<>'allocated_source_hours_before_day_lunch'
  or coalesce(p_snapshot->>'housecallJobId','')='' or coalesce(p_snapshot->>'customerId','')=''
  or p_snapshot->>'fromDate' !~ '^\d{4}-\d{2}-\d{2}$' or p_snapshot->>'toDate' !~ '^\d{4}-\d{2}-\d{2}$'
  or (p_snapshot->>'fromDate')::date>(p_snapshot->>'toDate')::date
  or jsonb_typeof(p_snapshot->'entries')<>'array' or jsonb_array_length(p_snapshot->'entries') not between 1 and 20000
  or p_snapshot#>'{disclosures,lunchRedistributed}'<>'true'::jsonb or p_snapshot#>'{disclosures,wageCostsIncluded}'<>'true'::jsonb
  or jsonb_array_length(p_snapshot#>'{disclosures,provisionalWorkerDates}')<>0
  or p_snapshot#>>'{providerIntent,version}'<>'1' or p_snapshot#>>'{providerIntent,destination}'<>'job_input_materials'
  or p_snapshot#>>'{providerIntent,costTreatment}'<>'approved_total_cost'
  or p_snapshot#>>'{providerIntent,preparedWrite,kind}'<>'job_cost'
  or p_snapshot#>>'{providerIntent,preparedWrite,jobId}'<>p_snapshot->>'housecallJobId'
  or p_snapshot#>>'{providerIntent,preparedWrite,method}'<>'PUT'
  or p_snapshot#>>'{providerIntent,preparedWrite,path}'<>'/jobs/'||(p_snapshot->>'housecallJobId')||'/job_input_materials/bulk_update'
  or p_snapshot#>>'{providerIntent,preparedWrite,requestHash}' !~ '^[a-f0-9]{64}$'
  or jsonb_array_length(p_snapshot#>'{providerIntent,preparedWrite,body,job_input_materials}')<>1
  or (p_snapshot#>>'{providerIntent,preparedWrite,body,job_input_materials,0,quantity}')::numeric<>1
  or (p_snapshot#>>'{providerIntent,preparedWrite,body,job_input_materials,0,unit_cost}')::numeric<>(p_snapshot#>>'{costEstimate,totalCostCents}')::bigint
  or p_snapshot#>>'{providerIntent,preparedWrite,body,job_input_materials,0,part_number}'<>p_snapshot#>>'{providerIntent,preparedWrite,reference}'
  or coalesce(p_snapshot#>>'{costEstimate,policyVersion}','')=''
  or jsonb_typeof(p_snapshot#>'{costEstimate,workers}')<>'array' or jsonb_array_length(p_snapshot#>'{costEstimate,workers}') not between 1 and 500
  or jsonb_typeof(p_snapshot#>'{costEstimate,workerWeeks}')<>'array' or jsonb_array_length(p_snapshot#>'{costEstimate,workerWeeks}') not between 1 and 5000
  or jsonb_typeof(p_snapshot->'approvedWorkerNames')<>'array' or jsonb_array_length(p_snapshot->'approvedWorkerNames')<>jsonb_array_length(p_snapshot#>'{costEstimate,workers}')
  ),true) then raise exception 'labor_approval_invalid_snapshot'; end if;
 for worker in select value from jsonb_array_elements(p_snapshot#>'{costEstimate,workers}') loop
  if coalesce((coalesce(worker->>'workerName','')=''
   or jsonb_typeof(worker->'sourceHourHundredths')<>'number' or worker->>'sourceHourHundredths' !~ '^\d+$'
   or jsonb_typeof(worker->'paidHourHundredths')<>'number' or worker->>'paidHourHundredths' !~ '^\d+$'
   or jsonb_typeof(worker->'regularHourHundredths')<>'number' or worker->>'regularHourHundredths' !~ '^\d+$'
   or jsonb_typeof(worker->'overtimeHourHundredths')<>'number' or worker->>'overtimeHourHundredths' !~ '^\d+$'
   or jsonb_typeof(worker->'totalCostCents')<>'number' or worker->>'totalCostCents' !~ '^\d+$'
   or (worker->>'paidHourHundredths')::bigint<>(worker->>'regularHourHundredths')::bigint+(worker->>'overtimeHourHundredths')::bigint
   or (worker->>'paidHourHundredths')::bigint>(worker->>'sourceHourHundredths')::bigint
   or (worker->>'totalCostCents')::bigint>2147483647),true) then raise exception 'labor_approval_invalid_snapshot'; end if;
  paid:=paid+(worker->>'paidHourHundredths')::bigint; regular:=regular+(worker->>'regularHourHundredths')::bigint;
  overtime:=overtime+(worker->>'overtimeHourHundredths')::bigint; cost:=cost+(worker->>'totalCostCents')::bigint; cost_source:=cost_source+(worker->>'sourceHourHundredths')::bigint;
 end loop;
 if coalesce((paid<>(p_snapshot#>>'{costEstimate,paidHourHundredths}')::bigint or regular<>(p_snapshot#>>'{costEstimate,regularHourHundredths}')::bigint
  or overtime<>(p_snapshot#>>'{costEstimate,overtimeHourHundredths}')::bigint or cost<>(p_snapshot#>>'{costEstimate,totalCostCents}')::bigint
  or cost_source<>(p_snapshot->>'totalHourHundredths')::bigint or paid<>regular+overtime or paid>cost_source or cost>2147483647),true) then raise exception 'labor_approval_invalid_snapshot'; end if;
 fingerprint:=public.labor_approval_source_fingerprint();
 select a.id into saved from public.labor_job_hour_approvals a where a.snapshot_hash=p_snapshot_hash and a.status in ('approved','failed') order by a.approved_at desc limit 1;
 if saved is not null then return public.labor_job_hour_approval_record(saved); end if;
 insert into public.labor_job_hour_approvals(snapshot,canonical_snapshot,snapshot_hash,source_revision,source_fingerprint,approved_by)
 values(p_snapshot,p_canonical,p_snapshot_hash,p_source_revision,fingerprint,p_actor_id) returning id into saved;
 for item in select value from jsonb_array_elements(p_snapshot->'entries') loop
  select * into source_import from public.labor_source_imports i where i.id=(item->>'sourceImportId')::uuid and i.active and i.kind='timesheet';
  if not found or source_import.file_sha256<>item->>'sourceFileSha256' or source_import.report is null then raise exception 'labor_approval_invalid_snapshot'; end if;
  select e into source from jsonb_array_elements(source_import.report->'entries')e where e->>'id'=item->>'sourceEntryId';
  if coalesce((source is null or source->>'date'<>item->>'date' or source->>'workerName'<>item->>'workerName'
   or source->>'sourceRow'<>item->>'sourceRow' or source->>'kind'<>item->>'sourceKind' or source->>'kind' not in ('work','travel')
   or source->>'clockIn'<>item->>'clockIn' or source->>'clockOut'<>item->>'clockOut'
   or (source->>'employeeId') is distinct from (item->>'employeeId')
   or (item->>'sourceJobKey')::jsonb is distinct from jsonb_build_array(source->>'jobName',source->>'jobAddress')
   or (source->>'hours')::numeric<=0 or (source->>'hours')::numeric*100<>(item->>'hourHundredths')::bigint
   or public.labor_approval_worker_key(source->>'workerName')<>item->>'normalizedWorkerName'
   or item->>'clockIn' !~ '^([01]\d|2[0-3]):[0-5]\d$' or item->>'clockOut' !~ '^([01]\d|2[0-3]):[0-5]\d$'
   or (item->>'date')::date not between (p_snapshot->>'fromDate')::date and (p_snapshot->>'toDate')::date
   or item->>'date'>=left(source_import.report->>'generatedAt',10)
   or not exists(select 1 from jsonb_array_elements(ledger.control->'jobMappings')m where m=item->'jobMapping' and m->>'housecallJobId'=p_snapshot->>'housecallJobId' and m->>'sourceKey'=item->>'destinationSourceKey' and item->>'date' between m->>'fromDate' and m->>'toDate')
   ),true) then raise exception 'labor_approval_invalid_snapshot'; end if;
  st:=split_part(item->>'clockIn',':',1)::integer*60+split_part(item->>'clockIn',':',2)::integer;
  en:=split_part(item->>'clockOut',':',1)::integer*60+split_part(item->>'clockOut',':',2)::integer;
  if en<=st or st<>(item->>'startMinute')::integer or en<>(item->>'endMinute')::integer then raise exception 'labor_approval_invalid_snapshot'; end if;
  if exists(select 1 from public.labor_job_hour_reservations r where r.released_at is null and r.work_date=(item->>'date')::date and r.start_minute<en and st<r.end_minute and (r.worker_name_key=item->>'normalizedWorkerName' or (r.employee_id is not null and r.employee_id=item->>'employeeId'))) then raise exception 'labor_approval_duplicate_interval'; end if;
  insert into public.labor_job_hour_reservations(approval_id,source_entry_id,worker_name_key,employee_id,work_date,start_minute,end_minute)
  values(saved,item->>'sourceEntryId',item->>'normalizedWorkerName',item->>'employeeId',(item->>'date')::date,st,en);
  total:=total+(item->>'hourHundredths')::bigint;
 end loop;
 if total<>(p_snapshot->>'totalHourHundredths')::bigint or total<=0 then raise exception 'labor_approval_invalid_snapshot'; end if;
 if (select count(distinct public.labor_approval_worker_key(w->>'workerName'))from jsonb_array_elements(p_snapshot#>'{costEstimate,workers}')w)<>jsonb_array_length(p_snapshot#>'{costEstimate,workers}') then raise exception 'labor_approval_invalid_snapshot';end if;
 if (select count(distinct public.labor_approval_worker_key(w))from jsonb_array_elements_text(p_snapshot->'approvedWorkerNames')w)<>jsonb_array_length(p_snapshot->'approvedWorkerNames') then raise exception 'labor_approval_invalid_snapshot';end if;
 for worker in select value from jsonb_array_elements(p_snapshot#>'{costEstimate,workers}') loop
  if not exists(select 1 from jsonb_array_elements_text(p_snapshot->'approvedWorkerNames')w where public.labor_approval_worker_key(w)=public.labor_approval_worker_key(worker->>'workerName'))then raise exception 'labor_approval_invalid_snapshot';end if;
  if (worker->>'sourceHourHundredths')::bigint is distinct from (select sum((e->>'hourHundredths')::bigint)from jsonb_array_elements(p_snapshot->'entries')e where e->>'normalizedWorkerName'=public.labor_approval_worker_key(worker->>'workerName')) then raise exception 'labor_approval_invalid_snapshot';end if;
 end loop;
 for worker in select value from jsonb_array_elements(p_snapshot#>'{costEstimate,workerWeeks}') loop
  if coalesce((coalesce(worker->>'key','')='' or jsonb_typeof(worker->'fingerprintContext')<>'string' or jsonb_typeof((worker->>'fingerprintContext')::jsonb)<>'object'),true) then raise exception 'labor_approval_invalid_snapshot';end if;
 end loop;
 insert into public.labor_job_hour_events(approval_id,actor_id,event,details)values(saved,p_actor_id,'approved',jsonb_build_object('snapshotHash',p_snapshot_hash,'sourceRevision',p_source_revision));
 return public.labor_job_hour_approval_record(saved);
end; $$;

create function public.invalidate_labor_job_hour_approval(p_approval_id uuid,p_actor_id uuid,p_reason text default 'revoked') returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare a public.labor_job_hour_approvals%rowtype;
begin
 perform 1 from public.labor_state where singleton for update;
 perform public.require_active_actor(p_actor_id,array['manager','admin']);
 select * into a from public.labor_job_hour_approvals where id=p_approval_id for update;
 if not found then raise exception 'labor_approval_not_found'; end if;
 if p_reason not in ('revoked','stale') then raise exception 'labor_approval_invalid_status'; end if;
 if a.status in ('sent','reconciliation_required') or exists(select 1 from public.labor_job_hour_attempts t where t.approval_id=a.id and t.dispatched_at is not null) then raise exception 'labor_approval_dispatch_uncertain'; end if;
 if a.status in ('revoked','stale') then return public.labor_job_hour_approval_record(a.id); end if;
 update public.labor_job_hour_approvals set status=p_reason,last_error=null where id=a.id;
 update public.labor_job_hour_attempts set status='failed',completed_at=clock_timestamp(),error_code=p_reason where approval_id=a.id and status='claimed';
 update public.labor_job_hour_reservations set released_at=clock_timestamp() where approval_id=a.id and released_at is null;
 insert into public.labor_job_hour_events(approval_id,actor_id,event)values(a.id,p_actor_id,p_reason);
 return public.labor_job_hour_approval_record(a.id);
end; $$;

create function public.claim_labor_job_hour_send(p_approval_id uuid,p_snapshot_hash text,p_source_revision bigint,p_actor_id uuid) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare ledger public.labor_state%rowtype; a public.labor_job_hour_approvals%rowtype; t public.labor_job_hour_attempts%rowtype;
begin
 select * into ledger from public.labor_state where singleton for update;
 perform public.require_active_actor(p_actor_id,array['manager','admin']);
 select * into a from public.labor_job_hour_approvals where id=p_approval_id for update;
 if not found then raise exception 'labor_approval_not_found'; end if;
 if ledger.revision<>p_source_revision or p_source_revision is null or a.snapshot_hash is distinct from p_snapshot_hash then raise exception 'labor_approval_stale'; end if;
 select * into t from public.labor_job_hour_attempts where approval_id=a.id order by created_at desc,id desc limit 1 for update;
 if t.dispatched_at is not null or a.status in ('sent','reconciliation_required') then raise exception 'labor_approval_dispatch_uncertain'; end if;
 if t.status='claimed' and t.expires_at>clock_timestamp() then raise exception 'labor_approval_invalid_status'; end if;
 if a.status not in ('approved','failed','sending') then raise exception 'labor_approval_invalid_status'; end if;
 if t.status='claimed' then update public.labor_job_hour_attempts set status='failed',completed_at=clock_timestamp(),error_code='lease_expired_before_dispatch' where id=t.id; end if;
 insert into public.labor_job_hour_attempts(approval_id,actor_id,source_revision)values(a.id,p_actor_id,p_source_revision) returning * into t;
 update public.labor_job_hour_approvals set status='sending',last_error=null where id=a.id;
 insert into public.labor_job_hour_events(approval_id,attempt_id,actor_id,event)values(a.id,t.id,p_actor_id,'send_claimed');
 return jsonb_build_object('approval',public.labor_job_hour_approval_record(a.id),'attempt',jsonb_build_object('id',t.id,'lease_token',t.lease_token,'expires_at',t.expires_at,'source_revision',t.source_revision));
end; $$;

create function public.mark_labor_job_hour_dispatched(p_approval_id uuid,p_attempt_id uuid,p_lease_token uuid) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare ledger public.labor_state%rowtype; a public.labor_job_hour_approvals%rowtype; t public.labor_job_hour_attempts%rowtype; live_actor boolean;
begin
 select * into ledger from public.labor_state where singleton for update;
 select * into a from public.labor_job_hour_approvals where id=p_approval_id for update;
 if not found then raise exception 'labor_approval_not_found'; end if;
 select * into t from public.labor_job_hour_attempts where id=p_attempt_id and approval_id=a.id for update;
 if not found or t.lease_token is distinct from p_lease_token then raise exception 'labor_approval_invalid_lease'; end if;
 if t.dispatched_at is not null then return jsonb_build_object('allowed',false,'approval',public.labor_job_hour_approval_record(a.id)); end if;
 if t.status<>'claimed' or a.status<>'sending' then return jsonb_build_object('allowed',false,'approval',public.labor_job_hour_approval_record(a.id)); end if;
 select exists(select 1 from public.profiles p where p.id=t.actor_id and not p.disabled and p.role in ('manager','admin')) into live_actor;
 if ledger.revision<>t.source_revision then
  update public.labor_job_hour_approvals set status='stale',last_error='source_changed_before_dispatch' where id=a.id;
  update public.labor_job_hour_attempts set status='failed',completed_at=clock_timestamp(),error_code='source_changed_before_dispatch' where id=t.id;
  update public.labor_job_hour_reservations set released_at=clock_timestamp() where approval_id=a.id and released_at is null;
 elsif not live_actor or t.expires_at<=clock_timestamp() then
  update public.labor_job_hour_approvals set status='failed',last_error=case when not live_actor then 'actor_disabled_before_dispatch' else 'lease_expired_before_dispatch' end where id=a.id;
  update public.labor_job_hour_attempts set status='failed',completed_at=clock_timestamp(),error_code='dispatch_not_authorized' where id=t.id;
 else
  update public.labor_job_hour_attempts set status='dispatched',dispatched_at=clock_timestamp() where id=t.id;
  insert into public.labor_job_hour_events(approval_id,attempt_id,actor_id,event)values(a.id,t.id,t.actor_id,'dispatch_marked');
  return jsonb_build_object('allowed',true,'approval',public.labor_job_hour_approval_record(a.id));
 end if;
 insert into public.labor_job_hour_events(approval_id,attempt_id,actor_id,event)values(a.id,t.id,t.actor_id,'dispatch_blocked');
 return jsonb_build_object('allowed',false,'approval',public.labor_job_hour_approval_record(a.id));
end; $$;

create function public.finish_labor_job_hour_attempt(p_approval_id uuid,p_attempt_id uuid,p_lease_token uuid,p_outcome jsonb) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare a public.labor_job_hour_approvals%rowtype; t public.labor_job_hour_attempts%rowtype; target text; reference text;
begin
 perform 1 from public.labor_state where singleton for update;
 select * into a from public.labor_job_hour_approvals where id=p_approval_id for update;
 if not found then raise exception 'labor_approval_not_found'; end if;
 select * into t from public.labor_job_hour_attempts where id=p_attempt_id and approval_id=a.id for update;
 if not found or t.lease_token is distinct from p_lease_token then raise exception 'labor_approval_invalid_lease'; end if;
 if a.status='sent' and t.status='sent' then return public.labor_job_hour_approval_record(a.id); end if;
 if coalesce((jsonb_typeof(p_outcome)<>'object' or p_outcome->>'status' not in ('sent','failed','reconciliation_required') or (p_outcome ? 'responseHash' and p_outcome->>'responseHash' !~ '^[a-f0-9]{64}$')),true) then raise exception 'labor_approval_invalid_outcome'; end if;
 if t.status not in ('claimed','dispatched','uncertain') or a.status not in ('sending','reconciliation_required') then raise exception 'labor_approval_invalid_status'; end if;
 if p_outcome->>'status'='sent' then
  reference:=p_outcome->>'providerReference';
  if t.dispatched_at is null or length(coalesce(reference,'')) not between 1 and 500 then raise exception 'labor_approval_invalid_outcome'; end if;
  target:='sent';
 else
  if p_outcome ? 'errorCode' and p_outcome->>'errorCode' !~ '^[a-z][a-z0-9_]{0,79}$' then raise exception 'labor_approval_invalid_outcome'; end if;
  target:=case when t.dispatched_at is not null then 'reconciliation_required' else 'failed' end;
 end if;
 update public.labor_job_hour_attempts set status=case when target='reconciliation_required' then 'uncertain' else target end,completed_at=clock_timestamp(),provider_reference=reference,response_hash=p_outcome->>'responseHash',error_code=case when target='reconciliation_required' then 'dispatch_outcome_uncertain' else p_outcome->>'errorCode' end where id=t.id;
 update public.labor_job_hour_approvals set status=target,sent_at=case when target='sent' then clock_timestamp() else null end,provider_reference=reference,last_error=case when target='reconciliation_required' then 'dispatch_outcome_uncertain' else p_outcome->>'errorCode' end where id=a.id;
 insert into public.labor_job_hour_events(approval_id,attempt_id,actor_id,event,details)values(a.id,t.id,t.actor_id,target,jsonb_build_object('providerReference',reference,'responseHash',p_outcome->>'responseHash'));
 return public.labor_job_hour_approval_record(a.id);
end; $$;

create function public.reconcile_labor_job_hour_approval(p_approval_id uuid,p_evidence jsonb,p_actor_id uuid) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare a public.labor_job_hour_approvals%rowtype; t public.labor_job_hour_attempts%rowtype; reference text;
begin
 perform 1 from public.labor_state where singleton for update;
 perform public.require_active_actor(p_actor_id,array['manager','admin']);
 select * into a from public.labor_job_hour_approvals where id=p_approval_id for update;
 if not found then raise exception 'labor_approval_not_found'; end if;
 if a.status='sent' then return public.labor_job_hour_approval_record(a.id); end if;
 select * into t from public.labor_job_hour_attempts where approval_id=a.id order by created_at desc,id desc limit 1 for update;
 if t.dispatched_at is null or a.status not in ('sending','reconciliation_required') then raise exception 'labor_approval_invalid_status'; end if;
 if t.status='dispatched' and t.expires_at>clock_timestamp() then raise exception 'labor_approval_invalid_status'; end if;
 if coalesce((jsonb_typeof(p_evidence)<>'object' or p_evidence->>'status' not in ('sent','absent','unknown') or (p_evidence ? 'responseHash' and p_evidence->>'responseHash' !~ '^[a-f0-9]{64}$')),true) then raise exception 'labor_approval_invalid_outcome'; end if;
 if p_evidence->>'status'='sent' then
  reference:=p_evidence->>'providerReference';
  if length(coalesce(reference,'')) not between 1 and 500 then raise exception 'labor_approval_invalid_outcome'; end if;
  update public.labor_job_hour_attempts set status='sent',completed_at=clock_timestamp(),provider_reference=reference,response_hash=p_evidence->>'responseHash' where id=t.id;
  update public.labor_job_hour_approvals set status='sent',sent_at=clock_timestamp(),provider_reference=reference,last_error=null where id=a.id;
 else
  -- Absence is not proof that a timed-out provider request can never commit.
  -- Keep reservations and permit further readback only; never create a new send.
  update public.labor_job_hour_attempts set status='uncertain',completed_at=clock_timestamp(),error_code='dispatch_outcome_uncertain',response_hash=p_evidence->>'responseHash' where id=t.id;
  update public.labor_job_hour_approvals set status='reconciliation_required',last_error='dispatch_outcome_uncertain' where id=a.id;
 end if;
 insert into public.labor_job_hour_events(approval_id,attempt_id,actor_id,event,details)values(a.id,t.id,p_actor_id,'readback',jsonb_build_object('result',p_evidence->>'status','providerReference',reference,'responseHash',p_evidence->>'responseHash'));
 return public.labor_job_hour_approval_record(a.id);
end; $$;

revoke all on function public.labor_approval_worker_key(text),public.labor_approval_source_fingerprint(),public.guard_labor_approval_immutability(),public.labor_job_hour_approval_record(uuid),public.read_labor_job_hour_approvals(),public.approve_labor_job_hours(jsonb,text,text,bigint,uuid),public.invalidate_labor_job_hour_approval(uuid,uuid,text),public.claim_labor_job_hour_send(uuid,text,bigint,uuid),public.mark_labor_job_hour_dispatched(uuid,uuid,uuid),public.finish_labor_job_hour_attempt(uuid,uuid,uuid,jsonb),public.reconcile_labor_job_hour_approval(uuid,jsonb,uuid) from public,anon,authenticated,service_role;
grant execute on function public.labor_approval_worker_key(text),public.labor_approval_source_fingerprint(),public.labor_job_hour_approval_record(uuid),public.read_labor_job_hour_approvals(),public.approve_labor_job_hours(jsonb,text,text,bigint,uuid),public.invalidate_labor_job_hour_approval(uuid,uuid,text),public.claim_labor_job_hour_send(uuid,text,bigint,uuid),public.mark_labor_job_hour_dispatched(uuid,uuid,uuid),public.finish_labor_job_hour_attempt(uuid,uuid,uuid,jsonb),public.reconcile_labor_job_hour_approval(uuid,jsonb,uuid) to service_role;
