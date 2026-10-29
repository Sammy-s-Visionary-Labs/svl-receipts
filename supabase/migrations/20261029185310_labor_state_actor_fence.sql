-- Preserve active-manager authorization across ledger lock waits and fence worker configuration writes.
create or replace function public.compare_and_swap_labor_state(
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
 select * into current_state from public.labor_state where singleton for update;
 if not found then raise exception 'labor_state_unavailable'; end if;
 if current_state.revision<>p_expected_revision then return null; end if;
 -- The manager can be disabled or demoted while this write waits for the ledger lock.
 -- Check the current profile only after the lock has been obtained.
 if p_actor_id is not null then
  perform public.require_active_actor(p_actor_id,array['manager','admin']);
 else
  -- A worker may update sources and operational progress, never manager configuration.
  -- Missing intervalDays is the legacy daily value; persisting that default is harmless.
  previous_config:=coalesce(current_state.control,'{}'::jsonb)-array['sync','workerLease','lastScheduledDate','workerCatchup']
   || jsonb_build_object('sync',jsonb_build_object('intervalDays',1)
     || (coalesce(current_state.control->'sync','{}'::jsonb)
       -array['status','command','commandId','lastAttemptAt','lastSuccessAt','nextRunAt','lastError','workerHeartbeatAt','coverageThrough']));
  next_config:=p_control-array['sync','workerLease','lastScheduledDate','workerCatchup']
   || jsonb_build_object('sync',jsonb_build_object('intervalDays',1)
     || (coalesce(p_control->'sync','{}'::jsonb)
       -array['status','command','commandId','lastAttemptAt','lastSuccessAt','nextRunAt','lastError','workerHeartbeatAt','coverageThrough']));
  if current_state.control is null or previous_config is distinct from next_config then
   raise exception 'labor_manager_actor_required' using errcode='42501';
  end if;
 end if;
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
 previous_config:=coalesce(current_state.control,'{}'::jsonb)-array['sync','workerLease','lastScheduledDate','workerCatchup'] || jsonb_build_object('sync',
  coalesce(current_state.control->'sync','{}'::jsonb)-array['status','lastAttemptAt','lastSuccessAt','nextRunAt','lastError','workerHeartbeatAt','coverageThrough']);
 next_config:=p_control-array['sync','workerLease','lastScheduledDate','workerCatchup'] || jsonb_build_object('sync',coalesce(p_control->'sync','{}'::jsonb)
  -array['status','lastAttemptAt','lastSuccessAt','nextRunAt','lastError','workerHeartbeatAt','coverageThrough']);
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

revoke all on function public.compare_and_swap_labor_state(bigint,jsonb,jsonb,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.compare_and_swap_labor_state(bigint,jsonb,jsonb,jsonb,uuid) to service_role;
