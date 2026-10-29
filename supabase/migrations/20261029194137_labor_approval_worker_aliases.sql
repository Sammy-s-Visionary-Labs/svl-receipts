-- Explicit reviewed worker aliases affect aggregation while raw source names and
-- employee IDs remain immutable. Identity keys retain all known source spellings.
alter table public.labor_job_hour_reservations
 add column identity_keys text[] not null default '{}'::text[]
 check(cardinality(identity_keys)<=502);

create function public.labor_approval_aliases_valid(p_aliases jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare item jsonb; source_key text; target_key text; sources text[]:='{}'; targets jsonb:='{}';
begin
 if p_aliases is null or jsonb_typeof(p_aliases)<>'array' or jsonb_array_length(p_aliases)>500 then return false; end if;
 for item in select value from jsonb_array_elements(p_aliases) loop
  if jsonb_typeof(item)<>'object' or jsonb_typeof(item->'alias') is distinct from 'string'
   or jsonb_typeof(item->'workerName') is distinct from 'string'
   or length(btrim(item->>'alias')) not between 1 and 200 or length(btrim(item->>'workerName')) not between 1 and 200 then return false;end if;
  source_key:=public.labor_approval_worker_key(item->>'alias'); target_key:=public.labor_approval_worker_key(item->>'workerName');
  if source_key='' or target_key='' or source_key=target_key or source_key=any(sources)
   or (targets ? target_key and targets->>target_key<>item->>'workerName') then return false;end if;
  sources:=array_append(sources,source_key);targets:=targets||jsonb_build_object(target_key,item->>'workerName');
 end loop;
 if exists(select 1 from jsonb_object_keys(targets) t where t=any(sources))then return false;end if;
 return true;
end; $$;

create function public.labor_approval_canonical_worker_key(p_name text,p_aliases jsonb) returns text
language sql immutable security invoker set search_path='' as $$
 select coalesce((select public.labor_approval_worker_key(a->>'workerName') from jsonb_array_elements(p_aliases)a
  where public.labor_approval_worker_key(a->>'alias')=public.labor_approval_worker_key(p_name) limit 1),public.labor_approval_worker_key(p_name));
$$;

create function public.labor_approval_worker_identity_keys(p_name text,p_aliases jsonb) returns text[]
language sql immutable security invoker set search_path='' as $$
 with canonical as(select public.labor_approval_canonical_worker_key(p_name,p_aliases) k), keys as(
  select public.labor_approval_worker_key(p_name) k union select k from canonical union
  select public.labor_approval_worker_key(a->>'alias') from jsonb_array_elements(p_aliases)a,canonical c where public.labor_approval_worker_key(a->>'workerName')=c.k
 )select array_agg(k order by k)from keys;
$$;

-- Identity equivalences cannot later be deleted/remapped to reopen reserved time.
-- New, explicitly reviewed aliases may be appended; removing rates remains separate.
create function public.guard_labor_worker_aliases() returns trigger
language plpgsql security invoker set search_path='' as $$
declare previous jsonb:=coalesce(old.control#>'{paySettings,workerAliases}','[]'::jsonb); current_aliases jsonb:=coalesce(new.control#>'{paySettings,workerAliases}','[]'::jsonb);
begin
 if not public.labor_approval_aliases_valid(current_aliases) or not current_aliases @> previous then
  raise exception 'labor_worker_aliases_immutable' using errcode='42501';
 end if;
 return new;
end; $$;
create trigger labor_worker_aliases_immutable before update on public.labor_state
 for each row execute function public.guard_labor_worker_aliases();

create or replace function public.approve_labor_job_hours(p_snapshot jsonb,p_canonical text,p_snapshot_hash text,p_source_revision bigint,p_actor_id uuid) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare ledger public.labor_state%rowtype; item jsonb; source jsonb; worker jsonb; source_import public.labor_source_imports%rowtype; saved uuid; fingerprint text; total bigint:=0; st integer; en integer; paid bigint:=0; regular bigint:=0; overtime bigint:=0; cost bigint:=0; cost_source bigint:=0; aliases jsonb; owner_identity_keys text[];
begin
 select * into ledger from public.labor_state where singleton for update;
 perform public.require_active_actor(p_actor_id,array['manager','admin']);
 if ledger.control is null or ledger.revision<>p_source_revision or p_source_revision is null then raise exception 'labor_approval_stale'; end if;
 aliases:=coalesce(ledger.control#>'{paySettings,workerAliases}','[]'::jsonb);
 if not public.labor_approval_aliases_valid(aliases) or coalesce(p_snapshot->'workerAliases','[]'::jsonb) is distinct from aliases then raise exception 'labor_approval_invalid_snapshot'; end if;
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
   or public.labor_approval_worker_key(coalesce(item->>'canonicalWorkerName',item->>'workerName'))<>public.labor_approval_canonical_worker_key(source->>'workerName',aliases)
   or item->>'clockIn' !~ '^([01]\d|2[0-3]):[0-5]\d$' or item->>'clockOut' !~ '^([01]\d|2[0-3]):[0-5]\d$'
   or (item->>'date')::date not between (p_snapshot->>'fromDate')::date and (p_snapshot->>'toDate')::date
   or item->>'date'>=left(source_import.report->>'generatedAt',10)
   or not exists(select 1 from jsonb_array_elements(ledger.control->'jobMappings')m where m=item->'jobMapping' and m->>'housecallJobId'=p_snapshot->>'housecallJobId' and m->>'sourceKey'=item->>'destinationSourceKey' and item->>'date' between m->>'fromDate' and m->>'toDate')
   ),true) then raise exception 'labor_approval_invalid_snapshot'; end if;
  st:=split_part(item->>'clockIn',':',1)::integer*60+split_part(item->>'clockIn',':',2)::integer;
  en:=split_part(item->>'clockOut',':',1)::integer*60+split_part(item->>'clockOut',':',2)::integer;
  if en<st or st<>(item->>'startMinute')::integer or en<>(item->>'endMinute')::integer
   or (en=st and ((item->>'hourHundredths')::bigint>2 or not coalesce((item->'reviewReasons') ? 'Positive source Hours have same-minute exported clocks; original Hours and clock strings were preserved.',false)))
   then raise exception 'labor_approval_invalid_snapshot'; end if;
  owner_identity_keys:=public.labor_approval_worker_identity_keys(item->>'workerName',aliases);
  if exists(select 1 from public.labor_job_hour_reservations r where r.released_at is null and r.work_date=(item->>'date')::date
   and (coalesce(nullif(r.identity_keys,'{}'::text[]),array[r.worker_name_key]) && owner_identity_keys or (r.employee_id is not null and r.employee_id=item->>'employeeId'))
   and (
    (r.start_minute<r.end_minute and st<en and r.start_minute<en and st<r.end_minute)
    or (r.start_minute=r.end_minute and st=en and r.start_minute=st and r.approval_id<>saved)
    or (r.start_minute=r.end_minute and st<en and st<r.start_minute and r.start_minute<en)
    or (st=en and r.start_minute<r.end_minute and r.start_minute<st and st<r.end_minute)
   )) then raise exception 'labor_approval_duplicate_interval'; end if;
  insert into public.labor_job_hour_reservations(approval_id,source_entry_id,worker_name_key,employee_id,work_date,start_minute,end_minute,identity_keys)
  values(saved,item->>'sourceEntryId',item->>'normalizedWorkerName',item->>'employeeId',(item->>'date')::date,st,en,owner_identity_keys);
  total:=total+(item->>'hourHundredths')::bigint;
 end loop;
 if total<>(p_snapshot->>'totalHourHundredths')::bigint or total<=0 then raise exception 'labor_approval_invalid_snapshot'; end if;
 if (select count(distinct public.labor_approval_worker_key(w->>'workerName'))from jsonb_array_elements(p_snapshot#>'{costEstimate,workers}')w)<>jsonb_array_length(p_snapshot#>'{costEstimate,workers}') then raise exception 'labor_approval_invalid_snapshot';end if;
 if (select count(distinct public.labor_approval_worker_key(w))from jsonb_array_elements_text(p_snapshot->'approvedWorkerNames')w)<>jsonb_array_length(p_snapshot->'approvedWorkerNames') then raise exception 'labor_approval_invalid_snapshot';end if;
 for worker in select value from jsonb_array_elements(p_snapshot#>'{costEstimate,workers}') loop
  if not exists(select 1 from jsonb_array_elements_text(p_snapshot->'approvedWorkerNames')w where public.labor_approval_worker_key(w)=public.labor_approval_worker_key(worker->>'workerName'))then raise exception 'labor_approval_invalid_snapshot';end if;
  if (worker->>'sourceHourHundredths')::bigint is distinct from (select sum((e->>'hourHundredths')::bigint)from jsonb_array_elements(p_snapshot->'entries')e where public.labor_approval_worker_key(coalesce(e->>'canonicalWorkerName',e->>'workerName'))=public.labor_approval_worker_key(worker->>'workerName')) then raise exception 'labor_approval_invalid_snapshot';end if;
 end loop;
 for worker in select value from jsonb_array_elements(p_snapshot#>'{costEstimate,workerWeeks}') loop
  if coalesce((coalesce(worker->>'key','')='' or jsonb_typeof(worker->'fingerprintContext')<>'string' or jsonb_typeof((worker->>'fingerprintContext')::jsonb)<>'object'),true) then raise exception 'labor_approval_invalid_snapshot';end if;
 end loop;
 insert into public.labor_job_hour_events(approval_id,actor_id,event,details)values(saved,p_actor_id,'approved',jsonb_build_object('snapshotHash',p_snapshot_hash,'sourceRevision',p_source_revision));
 return public.labor_job_hour_approval_record(saved);
end; $$;

revoke all on function public.approve_labor_job_hours(jsonb,text,text,bigint,uuid) from public,anon,authenticated,service_role;
grant execute on function public.approve_labor_job_hours(jsonb,text,text,bigint,uuid) to service_role;

revoke all on function public.labor_approval_aliases_valid(jsonb),public.labor_approval_canonical_worker_key(text,jsonb),public.labor_approval_worker_identity_keys(text,jsonb),public.guard_labor_worker_aliases() from public,anon,authenticated;
grant execute on function public.labor_approval_aliases_valid(jsonb),public.labor_approval_canonical_worker_key(text,jsonb),public.labor_approval_worker_identity_keys(text,jsonb),public.guard_labor_worker_aliases() to service_role;
