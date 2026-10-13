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

do $$ declare tab text; fn record; begin
 foreach tab in array array['labor_job_hour_approvals','labor_job_hour_attempts','labor_job_hour_reservations','labor_job_hour_events'] loop
  if not(select relrowsecurity from pg_class where oid=('public.'||tab)::regclass) then raise exception 'approval RLS missing'; end if;
  if has_table_privilege('anon','public.'||tab,'SELECT') or has_table_privilege('authenticated','public.'||tab,'SELECT') or has_table_privilege('authenticated','public.'||tab,'INSERT') or has_table_privilege('authenticated','public.'||tab,'UPDATE') or has_table_privilege('service_role','public.'||tab,'DELETE') then raise exception 'approval service-only boundary missing'; end if;
 end loop;
 for fn in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('approve_labor_job_hours','read_labor_job_hour_approvals','invalidate_labor_job_hour_approval','claim_labor_job_hour_send','mark_labor_job_hour_dispatched','finish_labor_job_hour_attempt','reconcile_labor_job_hour_approval') loop
  if has_function_privilege('anon',fn.oid,'EXECUTE') or has_function_privilege('authenticated',fn.oid,'EXECUTE') or not has_function_privilege('service_role',fn.oid,'EXECUTE') or (select prosecdef from pg_proc where oid=fn.oid) then raise exception 'approval privileged function exposed or bypasses RLS'; end if;
 end loop;
end; $$;
set local role authenticated;
do $$ begin
 begin perform public.read_labor_job_hour_approvals();raise exception 'authenticated read approval RPC';exception when insufficient_privilege then null;end;
 begin perform 1 from public.labor_job_hour_attempts;raise exception 'authenticated read attempt secret';exception when insufficient_privilege then null;end;
end; $$;
reset role;

set local role service_role;
do $$ declare s jsonb:=pg_temp.snapshot(1); approved jsonb; other jsonb; claim jsonb; attempt uuid; token uuid; approval_key uuid; rev bigint; begin
 begin perform pg_temp.approve(s,'93000000-0000-4000-8000-000000000003');raise exception 'worker approved hours';exception when others then if sqlerrm<>'forbidden' then raise;end if;end;
 begin perform pg_temp.approve(s,'93000000-0000-4000-8000-000000000004');raise exception 'disabled approved hours';exception when others then if sqlerrm<>'unauthenticated' then raise;end if;end;
 begin perform pg_temp.approve(s,null);raise exception 'null actor approved hours';exception when others then if sqlerrm<>'unauthenticated' then raise;end if;end;
 begin perform pg_temp.approve(s-'providerIntent');raise exception 'missing frozen provider intent';exception when others then if sqlerrm<>'labor_approval_invalid_snapshot' then raise;end if;end;
 begin perform pg_temp.approve(jsonb_set(s,'{costEstimate,totalCostCents}','999'));raise exception 'cost mismatch approved';exception when others then if sqlerrm<>'labor_approval_invalid_snapshot' then raise;end if;end;
 begin perform pg_temp.approve(jsonb_set(s,'{entries,0,clockOut}','""'));raise exception 'unknown clock approved';exception when others then if sqlerrm<>'labor_approval_invalid_snapshot' then raise;end if;end;
 begin perform public.approve_labor_job_hours(s,s::text,repeat('0',64),1,'93000000-0000-4000-8000-000000000001');raise exception 'wrong content hash approved';exception when others then if sqlerrm<>'labor_approval_invalid_snapshot' then raise;end if;end;
 begin perform public.approve_labor_job_hours(s,s::text,pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(s::text,'UTF8')),'hex'),0,'93000000-0000-4000-8000-000000000001');raise exception 'stale preview approved';exception when others then if sqlerrm<>'labor_approval_stale' then raise;end if;end;
 approved:=pg_temp.approve(s);approval_key:=(approved->>'id')::uuid;
 if approved->>'status'<>'approved' or (select count(*) from public.labor_job_hour_attempts)<>0 then raise exception 'approval implicitly sent or claimed';end if;
 if pg_temp.approve(s)->>'id'<>approval_key::text then raise exception 'approval retry not idempotent';end if;
 if (select count(*) from public.labor_job_hour_reservations where approval_id=approval_key and released_at is null)<>1 then raise exception 'approved interval unreserved';end if;
 other:=jsonb_set(s,'{toDate}','"2026-09-19"');
 begin perform pg_temp.approve(other);raise exception 'overlapping approval double-reserved';exception when others then if sqlerrm<>'labor_approval_duplicate_interval' then raise;end if;end;
 begin update public.labor_job_hour_approvals set snapshot=jsonb_set(snapshot,'{totalHourHundredths}','200')where labor_job_hour_approvals.id=approval_key;raise exception 'approved snapshot mutated';exception when insufficient_privilege then null;end;
 claim:=public.claim_labor_job_hour_send(approval_key,approved->>'snapshot_hash',1,'93000000-0000-4000-8000-000000000002');
 attempt:=(claim#>>'{attempt,id}')::uuid;token:=(claim#>>'{attempt,lease_token}')::uuid;
 if claim#>>'{approval,status}'<>'sending' then raise exception 'manual claim missing';end if;
 if (public.read_labor_job_hour_approvals()::text)like '%'||token::text||'%' then raise exception 'private dispatch token leaked to history';end if;
 begin perform public.claim_labor_job_hour_send(approval_key,approved->>'snapshot_hash',1,'93000000-0000-4000-8000-000000000001');raise exception 'second sender claimed live approval';exception when others then if sqlerrm<>'labor_approval_invalid_status' then raise;end if;end;
 begin perform public.mark_labor_job_hour_dispatched(approval_key,attempt,gen_random_uuid());raise exception 'wrong lease dispatched';exception when others then if sqlerrm<>'labor_approval_invalid_lease' then raise;end if;end;
 if public.mark_labor_job_hour_dispatched(approval_key,attempt,token)->>'allowed'<>'true' then raise exception 'valid dispatch blocked';end if;
 if public.mark_labor_job_hour_dispatched(approval_key,attempt,token)->>'allowed'<>'false' then raise exception 'same dispatch authorized twice';end if;
 approved:=public.finish_labor_job_hour_attempt(approval_key,attempt,token,'{"status":"failed","errorCode":"timeout"}');
 if approved->>'status'<>'reconciliation_required' then raise exception 'post-dispatch failure became retryable';end if;
 begin perform public.claim_labor_job_hour_send(approval_key,approved->>'snapshot_hash',1,'93000000-0000-4000-8000-000000000001');raise exception 'uncertain attempt resubmitted';exception when others then if sqlerrm<>'labor_approval_dispatch_uncertain' then raise;end if;end;
 begin perform public.invalidate_labor_job_hour_approval(approval_key,'93000000-0000-4000-8000-000000000001');raise exception 'uncertain reservations released';exception when others then if sqlerrm<>'labor_approval_dispatch_uncertain' then raise;end if;end;
 approved:=public.reconcile_labor_job_hour_approval(approval_key,'{"status":"absent"}','93000000-0000-4000-8000-000000000001');
 if approved->>'status'<>'reconciliation_required' or not exists(select 1 from public.labor_job_hour_reservations r where r.approval_id=approval_key and released_at is null)then raise exception 'readback absence authorized replay';end if;
 approved:=public.reconcile_labor_job_hour_approval(approval_key,'{"status":"sent","providerReference":"TEST_PROVIDER_MATERIAL","responseHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}','93000000-0000-4000-8000-000000000001');
 if approved->>'status'<>'sent' or approved->>'sent_at' is null then raise exception 'exact synthetic readback did not finalize';end if;
 if public.finish_labor_job_hour_attempt(approval_key,attempt,token,'{"status":"sent","providerReference":"TEST_PROVIDER_MATERIAL"}')->>'status'<>'sent' then raise exception 'completion retry not idempotent';end if;
 begin update public.labor_job_hour_approvals set last_error='changed'where labor_job_hour_approvals.id=approval_key;raise exception 'sent row mutable';exception when insufficient_privilege then null;end;
 begin update public.labor_job_hour_attempts set error_code='changed'where labor_job_hour_attempts.id=attempt;raise exception 'sent attempt mutable';exception when insufficient_privilege then null;end;
 begin update public.labor_job_hour_reservations set released_at=clock_timestamp()where approval_id=approval_key;raise exception 'sent reservation released';exception when insufficient_privilege then null;end;
 if exists(select 1 from public.labor_job_hour_events where details::text like '%'||token::text||'%')then raise exception 'lease token audited';end if;
end; $$;

do $$ declare source jsonb; s jsonb; approved jsonb; begin
 -- A new workbook, renamed worker and changed entry ID still collide through
 -- employee identity with the already-sent TEST_ROW_1 reservation.
 select e into source from public.labor_source_imports i cross join lateral jsonb_array_elements(i.report->'entries')e where i.id='93000000-0000-4000-8000-000000000010' and e->>'id'='TEST_ROW_1';
 source:=source||jsonb_build_object('id','TEST_ROW_21','workerName','TEST RENAMED','sourceRow',21,'clockIn','08:15','clockOut','09:15');
 insert into public.labor_source_imports(id,kind,position,file_sha256,content_hash,summary,report)values('93000000-0000-4000-8000-000000000011','timesheet',1,repeat('d',64),repeat('e',64),'{}',jsonb_build_object('generatedAt','2026-09-19 01:00:00 AM','entries',jsonb_build_array(source)));
 s:=pg_temp.snapshot(21);
 begin perform pg_temp.approve(s);raise exception 'replacement workbook renamed employee double-sent';exception when others then if sqlerrm<>'labor_approval_duplicate_interval' then raise;end if;end;
 -- Changing employee ID cannot bypass the independent normalized-name check.
 source:=source||jsonb_build_object('id','TEST_ROW_22','workerName','Worker, Test 1','employeeId','TEST_CHANGED_ID','sourceRow',22);
 update public.labor_source_imports set report=jsonb_set(report,'{entries}',jsonb_build_array(source))where id='93000000-0000-4000-8000-000000000011';
 s:=pg_temp.snapshot(22);
 begin perform pg_temp.approve(s);raise exception 'changed employee ID double-sent same name interval';exception when others then if sqlerrm<>'labor_approval_duplicate_interval' then raise;end if;end;
 -- Remapping the same span to another provider job also keeps the reservation.
 update public.labor_state set control=jsonb_set(control,'{jobMappings,0,housecallJobId}','"job_remapped_test"')where singleton;
 s:=pg_temp.snapshot(22,'job_remapped_test');
 begin perform pg_temp.approve(s);raise exception 'job remap bypassed sent interval reservation';exception when others then if sqlerrm<>'labor_approval_duplicate_interval' then raise;end if;end;
 update public.labor_state set control=jsonb_set(control,'{jobMappings,0,housecallJobId}','"job_test"')where singleton;
 -- Adjacent spans are distinct work; reservation is not a blanket worker-day lock.
 source:=source||jsonb_build_object('id','TEST_ROW_23','sourceRow',23,'clockIn','09:00','clockOut','10:00');
 update public.labor_source_imports set report=jsonb_set(report,'{entries}',jsonb_build_array(source))where id='93000000-0000-4000-8000-000000000011';
 approved:=pg_temp.approve(pg_temp.snapshot(23));
 if approved->>'status'<>'approved' then raise exception 'non-overlapping adjacent span blocked';end if;
 perform public.invalidate_labor_job_hour_approval((approved->>'id')::uuid,'93000000-0000-4000-8000-000000000001');
end; $$;

do $$ declare s jsonb:=pg_temp.snapshot(2); a jsonb; c jsonb; approval_key uuid; attempt uuid; token uuid; begin
 a:=pg_temp.approve(s);approval_key:=(a->>'id')::uuid;
 -- An unrelated operational/source revision is allowed only through a newly
 -- rebuilt exact hash and current preview revision; global equality is not used.
 update public.labor_state set revision=revision+1,control=jsonb_set(control,'{unrelatedReview}','true')where singleton;
 begin perform public.claim_labor_job_hour_send(approval_key,a->>'snapshot_hash',1,'93000000-0000-4000-8000-000000000001');raise exception 'stale preview claimed';exception when others then if sqlerrm<>'labor_approval_stale' then raise;end if;end;
 c:=public.claim_labor_job_hour_send(approval_key,a->>'snapshot_hash',2,'93000000-0000-4000-8000-000000000001');attempt:=(c#>>'{attempt,id}')::uuid;token:=(c#>>'{attempt,lease_token}')::uuid;
 update public.labor_state set revision=revision+1 where singleton;
 if public.mark_labor_job_hour_dispatched(approval_key,attempt,token)->>'allowed'<>'false' or (public.labor_job_hour_approval_record(approval_key))->>'status'<>'stale' then raise exception 'source update raced dispatch fence';end if;
 if exists(select 1 from public.labor_job_hour_reservations r where r.approval_id=approval_key and released_at is null)then raise exception 'undispatched stale reservation retained';end if;
 a:=pg_temp.approve(s);approval_key:=(a->>'id')::uuid;
 c:=public.claim_labor_job_hour_send(approval_key,a->>'snapshot_hash',3,'93000000-0000-4000-8000-000000000001');attempt:=(c#>>'{attempt,id}')::uuid;token:=(c#>>'{attempt,lease_token}')::uuid;
 a:=public.finish_labor_job_hour_attempt(approval_key,attempt,token,'{"status":"failed","errorCode":"provider_unavailable_before_dispatch"}');
 if a->>'status'<>'failed' then raise exception 'safe predispatch failure not retryable';end if;
 c:=public.claim_labor_job_hour_send(approval_key,a->>'snapshot_hash',3,'93000000-0000-4000-8000-000000000001');
 a:=public.invalidate_labor_job_hour_approval(approval_key,'93000000-0000-4000-8000-000000000001','revoked');
 if a->>'status'<>'revoked' or exists(select 1 from public.labor_job_hour_reservations r where r.approval_id=approval_key and released_at is null)then raise exception 'manual revoke failed to release undispatched interval';end if;
end; $$;

do $$ declare s jsonb:=pg_temp.snapshot(3); a jsonb; approval_key uuid; c jsonb; attempt uuid; token uuid; begin
 a:=pg_temp.approve(s);approval_key:=(a->>'id')::uuid;
 c:=public.claim_labor_job_hour_send(approval_key,a->>'snapshot_hash',3,'93000000-0000-4000-8000-000000000001');attempt:=(c#>>'{attempt,id}')::uuid;token:=(c#>>'{attempt,lease_token}')::uuid;
 -- Real actor state is checked again at dispatch, independent of the earlier claim.
 update public.profiles set disabled=true where profiles.id='93000000-0000-4000-8000-000000000001';
 if public.mark_labor_job_hour_dispatched(approval_key,attempt,token)->>'allowed'<>'false' then raise exception 'disabled claimant dispatched';end if;
 update public.profiles set disabled=false where profiles.id='93000000-0000-4000-8000-000000000001';
 perform public.invalidate_labor_job_hour_approval(approval_key,'93000000-0000-4000-8000-000000000002');
end; $$;

do $$ declare s jsonb:=pg_temp.snapshot(4); a jsonb; approval_key uuid; attempt uuid; token uuid; c jsonb; begin
 a:=pg_temp.approve(s);approval_key:=(a->>'id')::uuid;
 -- A synthetic already-expired pre-dispatch lease exercises recovery without
 -- sleeping or changing immutable lease fields after creation.
 insert into public.labor_job_hour_attempts(approval_id,actor_id,source_revision,created_at,expires_at)values(approval_key,'93000000-0000-4000-8000-000000000001',3,clock_timestamp()-interval '3 minutes',clock_timestamp()-interval '1 minute')returning labor_job_hour_attempts.id,lease_token into attempt,token;
 update public.labor_job_hour_approvals set status='sending' where labor_job_hour_approvals.id=approval_key;
 if public.mark_labor_job_hour_dispatched(approval_key,attempt,token)->>'allowed'<>'false' then raise exception 'expired predispatch lease authorized';end if;
 c:=public.claim_labor_job_hour_send(approval_key,a->>'snapshot_hash',3,'93000000-0000-4000-8000-000000000001');
 if c is null then raise exception 'fresh reviewed retry could not claim';end if;
 perform public.invalidate_labor_job_hour_approval(approval_key,'93000000-0000-4000-8000-000000000001');
end; $$;
reset role;
do $$ begin
 begin update public.labor_job_hour_events set event='changed';raise exception 'approval events mutable by owner';exception when insufficient_privilege then null;end;
 begin delete from public.labor_job_hour_events;raise exception 'approval audit deletable by owner';exception when insufficient_privilege then null;end;
end; $$;
rollback;
