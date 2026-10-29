-- Synthetic, rollback-only approval/reservation/send-ledger checks. No HTTP.
begin;
insert into auth.users(id,aud,role,email,raw_app_meta_data) values
 ('93000000-0000-4000-8000-000000000001','authenticated','authenticated','approval-manager@example.invalid','{"svl_access_approved":true}'),
 ('93000000-0000-4000-8000-000000000002','authenticated','authenticated','approval-admin@example.invalid','{"svl_access_approved":true}'),
 ('93000000-0000-4000-8000-000000000003','authenticated','authenticated','approval-worker@example.invalid','{"svl_access_approved":true}'),
 ('93000000-0000-4000-8000-000000000004','authenticated','authenticated','approval-disabled@example.invalid','{"svl_access_approved":true}');
update public.profiles set role='manager' where id in ('93000000-0000-4000-8000-000000000001','93000000-0000-4000-8000-000000000004');
update public.profiles set role='admin' where id='93000000-0000-4000-8000-000000000002';
update public.profiles set disabled=true where id='93000000-0000-4000-8000-000000000004';
update public.labor_source_imports set active=false;
insert into public.labor_source_imports(id,kind,position,file_sha256,content_hash,summary,report)
select '93000000-0000-4000-8000-000000000010','timesheet',0,repeat('a',64),repeat('b',64),'{}',jsonb_build_object('generatedAt','2026-09-19 01:00:00 AM','entries',jsonb_agg(jsonb_build_object(
 'id','TEST_ROW_'||n,'kind','work','date','2026-09-18','workerName','Worker, Test '||n,'employeeId','TEST_EMPLOYEE_'||n,
 'sourceRow',n,'hours',1,'jobName','TEST Customer','jobAddress','TEST Address','clockIn','08:00','clockOut','09:00')))
from generate_series(1,20)n;
update public.labor_state set revision=1,control=jsonb_build_object('version',1,'sync',jsonb_build_object('enabled',false),
 'jobMappings',jsonb_build_array(jsonb_build_object('sourceKey','["TEST Customer","TEST Address"]','housecallJobId','job_test','fromDate','2026-09-17','toDate','2026-09-30','confirmedAt','2026-09-19T00:00:00Z','confirmedBy','93000000-0000-4000-8000-000000000001','method','reviewed'))) where singleton;

create function pg_temp.snapshot(p_row integer,p_job text default 'job_test') returns jsonb language plpgsql as $$
declare source jsonb; mapping jsonb; worker text; result jsonb; original_id uuid; original_hash text;
begin
 select e,i.id,i.file_sha256 into source,original_id,original_hash from public.labor_source_imports i cross join lateral jsonb_array_elements(i.report->'entries')e where i.active and e->>'id'='TEST_ROW_'||p_row;
 select m into mapping from public.labor_state s cross join lateral jsonb_array_elements(s.control->'jobMappings')m where s.singleton and m->>'housecallJobId'=p_job limit 1;
 worker:=source->>'workerName';
 result:=jsonb_build_object('version',1,'housecallJobId',p_job,'customerId','customer_test','jobName','TEST Job','jobNumber','1001','jobAddress','TEST Address','customerName','TEST Customer','fromDate','2026-09-18','toDate','2026-09-18','allocationRulesVersion','TEST','hourBasis','allocated_source_hours_before_day_lunch','totalHourHundredths',100,'travelHourHundredths',0,
  'entries',jsonb_build_array(jsonb_build_object('sourceEntryId',source->>'id','sourceImportId',original_id,'sourceFileSha256',original_hash,'sourceRow',source->'sourceRow','workerName',worker,'normalizedWorkerName',public.labor_approval_worker_key(worker),'employeeId',source->'employeeId','date',source->>'date','clockIn',source->>'clockIn','clockOut',source->>'clockOut','startMinute',split_part(source->>'clockIn',':',1)::integer*60+split_part(source->>'clockIn',':',2)::integer,'endMinute',split_part(source->>'clockOut',':',1)::integer*60+split_part(source->>'clockOut',':',2)::integer,'hourHundredths',100,'sourceKind','work','sourceJobKey','["TEST Customer","TEST Address"]','destinationSourceKey','["TEST Customer","TEST Address"]','reason','reviewed_customer','reviewReasons','[]'::jsonb,'noteIds','[]'::jsonb,'jobMapping',mapping)),
  'workerDays',jsonb_build_array(jsonb_build_object('key','TEST_DAY_'||p_row,'date','2026-09-18','workerName',worker,'grossHours',1,'sourceBreakHours',0,'sourceNetHours',1,'lunchAdjustmentHours',0,'breakDifferenceHours',0,'netHours',1,'allocatedHours',1,'excludedHours',0,'pendingHours',0,'reviewReasons','[]'::jsonb)),
  'unresolved',jsonb_build_object('entryCount',0,'hourHundredths',0),'disclosures',jsonb_build_object('lunchRedistributed',true,'wageCostsIncluded',true,'provisionalWorkerDates','[]'::jsonb),
  'costEstimate',jsonb_build_object('policyVersion','TEST_COST','paidHourHundredths',100,'regularHourHundredths',100,'overtimeHourHundredths',0,'totalCostCents',2000,'workers',jsonb_build_array(jsonb_build_object('workerName',worker,'sourceHourHundredths',100,'paidHourHundredths',100,'regularHourHundredths',100,'overtimeHourHundredths',0,'totalCostCents',2000)),'workerWeeks',jsonb_build_array(jsonb_build_object('key','TEST_WEEK_'||p_row,'fingerprintContext','{"complete":true,"rateCents":2000}'))),
  'approvedWorkerNames',jsonb_build_array(worker),
  'providerIntent',jsonb_build_object('version',1,'destination','job_input_materials','costTreatment','approved_total_cost','preparedWrite',jsonb_build_object('kind','job_cost','jobId',p_job,'method','PUT','path','/jobs/'||p_job||'/job_input_materials/bulk_update','reference','SVL-LABOR-TEST-'||p_row,'requestHash',repeat('c',64),'body',jsonb_build_object('job_input_materials',jsonb_build_array(jsonb_build_object('name','TEST Labor 1.00h','description','TEST Worker 1.00h','part_number','SVL-LABOR-TEST-'||p_row,'quantity',1,'unit_cost',2000))))));
 return result;
end; $$;
create function pg_temp.approve(p_snapshot jsonb,p_actor uuid default '93000000-0000-4000-8000-000000000001')returns jsonb language sql as $$
 select public.approve_labor_job_hours(p_snapshot,p_snapshot::text,pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_snapshot::text,'UTF8')),'hex'),(select revision from public.labor_state where singleton),p_actor);
$$;


-- Re-label only synthetic parsed fixture rows; original raw identity is authoritative.
update public.labor_source_imports set report=jsonb_set(report,'{entries}',(
 select jsonb_agg(e||case e->>'id'
  when 'TEST_ROW_1' then jsonb_build_object('workerName','TEST Canonical Worker')
  when 'TEST_ROW_2' then jsonb_build_object('workerName','TEST Alias')
  when 'TEST_ROW_3' then jsonb_build_object('workerName','Worker, TEST Canonical')
  when 'TEST_ROW_4' then jsonb_build_object('workerName','TEST New Alias')
  when 'TEST_ROW_5' then jsonb_build_object('workerName','TEST Unrelated Worker')
  when 'TEST_ROW_6' then jsonb_build_object('workerName','TEST Alias','clockIn','09:00','clockOut','10:00')
  when 'TEST_ROW_7' then jsonb_build_object('workerName','TEST New Alias','clockIn','09:00','clockOut','10:00')
  when 'TEST_ROW_8' then jsonb_build_object('workerName','TEST Unrelated Renamed Worker','employeeId','TEST_EMPLOYEE_1')
  else '{}'::jsonb end order by (e->>'sourceRow')::integer)
 from jsonb_array_elements(report->'entries')e))where id='93000000-0000-4000-8000-000000000010';

-- Model an actual pre-migration sent reservation: the new identity_keys column is empty.
do $$ declare s jsonb:=pg_temp.snapshot(1); saved uuid; begin
 insert into public.labor_job_hour_approvals(snapshot,canonical_snapshot,snapshot_hash,source_revision,source_fingerprint,approved_by,status,sent_at,provider_reference)
 values(s,s::text,pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(s::text,'UTF8')),'hex'),1,public.labor_approval_source_fingerprint(),'93000000-0000-4000-8000-000000000001','sent',clock_timestamp(),'TEST_LEGACY_ALIAS_MATERIAL')returning id into saved;
 insert into public.labor_job_hour_attempts(approval_id,actor_id,source_revision,status,dispatched_at,completed_at)
 values(saved,'93000000-0000-4000-8000-000000000001',1,'sent',clock_timestamp(),clock_timestamp());
 insert into public.labor_job_hour_reservations(approval_id,source_entry_id,worker_name_key,employee_id,work_date,start_minute,end_minute)
 values(saved,'TEST_ROW_1','test canonical worker','TEST_EMPLOYEE_1','2026-09-18',480,540);
end; $$;
update public.labor_state set revision=revision+1,control=jsonb_set(control,'{paySettings}',jsonb_build_object('workerAliases',jsonb_build_array(jsonb_build_object('alias','TEST Alias','workerName','TEST Canonical Worker')))) where singleton;

create function pg_temp.alias_snapshot(p_row integer) returns jsonb language plpgsql as $$
declare s jsonb:=pg_temp.snapshot(p_row); aliases jsonb; canonical_name text;
begin
 select control#>'{paySettings,workerAliases}' into aliases from public.labor_state where singleton;
 canonical_name:=case when p_row=5 then 'TEST Unrelated Worker' else 'TEST Canonical Worker' end;
 s:=s||jsonb_build_object('workerAliases',aliases,'approvedWorkerNames',jsonb_build_array(canonical_name));
 s:=jsonb_set(s,'{entries,0,canonicalWorkerName}',to_jsonb(canonical_name));
 s:=jsonb_set(s,'{costEstimate,workers,0,workerName}',to_jsonb(canonical_name));
 s:=jsonb_set(s,'{workerDays,0,workerName}',to_jsonb(canonical_name));
 return s;
end; $$;

set local role service_role;
do $$ declare s jsonb; saved jsonb; before_keys text[]; aliases jsonb; fn record; begin
 for fn in select oid from pg_proc where pronamespace='public'::regnamespace and proname in ('labor_approval_aliases_valid','labor_approval_canonical_worker_key','labor_approval_worker_identity_keys','guard_labor_worker_aliases') loop
  if has_function_privilege('anon',fn.oid,'EXECUTE') or has_function_privilege('authenticated',fn.oid,'EXECUTE') or not has_function_privilege('service_role',fn.oid,'EXECUTE')then raise exception 'worker identity function privilege leaked';end if;
 end loop;
 if not exists(select 1 from public.labor_job_hour_reservations where source_entry_id='TEST_ROW_1' and cardinality(identity_keys)=0)then raise exception 'legacy empty identity fixture missing';end if;
 s:=pg_temp.alias_snapshot(2);
 begin perform pg_temp.approve(jsonb_set(s,'{entries,0,canonicalWorkerName}','"TEST Forged Owner"'));raise exception 'forged canonical worker accepted';exception when others then if sqlerrm<>'labor_approval_invalid_snapshot' then raise;end if;end;
 begin perform pg_temp.approve(jsonb_set(s,'{entries,0,normalizedWorkerName}','"test canonical worker"'));raise exception 'raw normalized identity rewritten';exception when others then if sqlerrm<>'labor_approval_invalid_snapshot' then raise;end if;end;
 begin perform pg_temp.approve(s-'workerAliases');raise exception 'unreviewed alias config accepted';exception when others then if sqlerrm<>'labor_approval_invalid_snapshot' then raise;end if;end;
 begin perform pg_temp.approve(s);raise exception 'alias bypassed legacy raw reservation';exception when others then if sqlerrm<>'labor_approval_duplicate_interval' then raise;end if;end;
 begin perform pg_temp.approve(pg_temp.alias_snapshot(3));raise exception 'reverse-comma spelling bypassed legacy reservation';exception when others then if sqlerrm<>'labor_approval_duplicate_interval' then raise;end if;end;
 begin perform pg_temp.approve(pg_temp.snapshot(8)||jsonb_build_object('workerAliases',s->'workerAliases'));raise exception 'same employee ID with unrelated name bypassed legacy reservation';exception when others then if sqlerrm<>'labor_approval_duplicate_interval' then raise;end if;end;
 saved:=pg_temp.approve(pg_temp.alias_snapshot(6));
 select identity_keys into before_keys from public.labor_job_hour_reservations where approval_id=(saved->>'id')::uuid;
 if before_keys is distinct from array['test alias','test canonical worker']then raise exception 'new approval did not reserve both identities';end if;
 begin update public.labor_job_hour_reservations set identity_keys=array['test forged owner']where approval_id=(saved->>'id')::uuid;raise exception 'reservation identity keys mutable';exception when others then if sqlerrm<>'labor_approval_immutable'then raise;end if;end;
 if saved#>>'{snapshot,entries,0,workerName}'<>'TEST Alias' or saved#>>'{snapshot,entries,0,normalizedWorkerName}'<>'test alias' or saved#>>'{snapshot,entries,0,canonicalWorkerName}'<>'TEST Canonical Worker'then raise exception 'raw/canonical provenance changed';end if;
 if saved#>>'{snapshot,entries,0,employeeId}'<>'TEST_EMPLOYEE_6'then raise exception 'source employee ID replaced';end if;
 -- An unrelated worker at exactly the same clock span still has independent hours.
 if pg_temp.approve(pg_temp.alias_snapshot(5))->>'status'<>'approved'then raise exception 'unrelated owner blocked by alias';end if;
 select control#>'{paySettings,workerAliases}' into aliases from public.labor_state where singleton;
 begin update public.labor_state set control=jsonb_set(control,'{paySettings,workerAliases}','[]')where singleton;raise exception 'alias removal reopened identity';exception when others then if sqlerrm<>'labor_worker_aliases_immutable'then raise;end if;end;
 begin update public.labor_state set control=jsonb_set(control,'{paySettings,workerAliases}',jsonb_build_array(jsonb_build_object('alias','TEST Alias','workerName','TEST Other Worker')))where singleton;raise exception 'alias remap reopened identity';exception when others then if sqlerrm<>'labor_worker_aliases_immutable'then raise;end if;end;
 begin update public.labor_state set control=jsonb_set(control,'{paySettings,workerAliases}',aliases||jsonb_build_array(jsonb_build_object('alias','TEST Canonical Worker','workerName','TEST Chain')))where singleton;raise exception 'identity chain accepted';exception when others then if sqlerrm<>'labor_worker_aliases_immutable'then raise;end if;end;
 update public.labor_state set revision=revision+1,control=jsonb_set(control,'{paySettings,workerAliases}',aliases||jsonb_build_array(jsonb_build_object('alias','TEST New Alias','workerName','TEST Canonical Worker')))where singleton;
 begin perform pg_temp.approve(pg_temp.alias_snapshot(4));raise exception 'new alias bypassed legacy identity';exception when others then if sqlerrm<>'labor_approval_duplicate_interval'then raise;end if;end;
 begin perform pg_temp.approve(pg_temp.alias_snapshot(7));raise exception 'new alias bypassed expanded identity';exception when others then if sqlerrm<>'labor_approval_duplicate_interval'then raise;end if;end;
 if before_keys is distinct from (select identity_keys from public.labor_job_hour_reservations where approval_id=(saved->>'id')::uuid)then raise exception 'existing immutable reservation mutated';end if;
 if not exists(select 1 from public.labor_job_hour_reservations where source_entry_id='TEST_ROW_1' and released_at is null and cardinality(identity_keys)=0)then raise exception 'legacy reservation changed or released';end if;
 if public.labor_approval_worker_identity_keys('TEST New Alias',(select control#>'{paySettings,workerAliases}'from public.labor_state where singleton)) is distinct from array['test alias','test canonical worker','test new alias']then raise exception 'new alias identity set incomplete';end if;
end; $$;
reset role;
rollback;
