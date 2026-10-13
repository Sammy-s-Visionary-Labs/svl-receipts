-- Additive precision regression; every fixture and approval is rolled back. No HTTP.
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

-- One owner with tiny positive source rows, adjacent positive spans and invalid
-- larger/reversed rows. Distinct point IDs preserve occurrence provenance.
update public.labor_source_imports i set report=jsonb_set(i.report,'{entries}',(i.report->'entries')||(
 select jsonb_agg((i.report#>'{entries,0}')||jsonb_build_object('id','TEST_ROW_'||p.row_number,'sourceRow',p.row_number,'clockIn',p.clock_in,'clockOut',p.clock_out,'hours',p.hours))
 from(values(21,'08:00','08:00',0.01::numeric),(22,'08:00','08:00',0.02),(23,'08:00','09:00',1.00),(24,'08:30','08:30',0.01),(25,'09:00','09:00',0.01),(26,'07:30','07:30',0.01),(27,'09:00','10:00',1.00),(28,'00:00','00:00',0.01),(29,'10:00','10:00',0.03),(30,'10:00','09:59',0.01),(31,'10:00','10:00',0.00))p(row_number,clock_in,clock_out,hours)
))where i.id='93000000-0000-4000-8000-000000000010';

create function pg_temp.precision_snapshot(p_rows integer[],p_job text default 'job_test')returns jsonb language plpgsql as $$
declare snapshot jsonb:=pg_temp.snapshot(p_rows[1],p_job); entries jsonb:='[]'; item jsonb; source jsonb; n integer; hh bigint; total bigint:=0; field text;
begin
 foreach n in array p_rows loop
  item:=pg_temp.snapshot(n,p_job)#>'{entries,0}';
  select e into source from public.labor_source_imports i cross join lateral jsonb_array_elements(i.report->'entries')e where i.active and e->>'id'='TEST_ROW_'||n;
  hh:=((source->>'hours')::numeric*100)::bigint;
  item:=jsonb_set(item,'{hourHundredths}',to_jsonb(hh));
  if item->>'startMinute'=item->>'endMinute' and hh>0 then
   item:=jsonb_set(item,'{reviewReasons}',jsonb_build_array('Positive source Hours have same-minute exported clocks; original Hours and clock strings were preserved.'));
  end if;
  entries:=entries||jsonb_build_array(item);total:=total+hh;
 end loop;
 snapshot:=jsonb_set(snapshot,'{entries}',entries);
 snapshot:=jsonb_set(snapshot,'{totalHourHundredths}',to_jsonb(total));
 foreach field in array array['paidHourHundredths','regularHourHundredths']loop
  snapshot:=jsonb_set(snapshot,array['costEstimate',field],to_jsonb(total));
  snapshot:=jsonb_set(snapshot,array['costEstimate','workers','0',field],to_jsonb(total));
 end loop;
 snapshot:=jsonb_set(snapshot,'{costEstimate,workers,0,sourceHourHundredths}',to_jsonb(total));
 snapshot:=jsonb_set(snapshot,'{costEstimate,totalCostCents}',to_jsonb(total*20));
 snapshot:=jsonb_set(snapshot,'{costEstimate,workers,0,totalCostCents}',to_jsonb(total*20));
 snapshot:=jsonb_set(snapshot,'{providerIntent,preparedWrite,body,job_input_materials,0,unit_cost}',to_jsonb(total*20));
 snapshot:=jsonb_set(snapshot,'{providerIntent,preparedWrite,body,job_input_materials,0,name}',to_jsonb('TEST precision source hours '||(total::numeric/100)::text));
 foreach field in array array['grossHours','sourceNetHours','netHours','allocatedHours']loop snapshot:=jsonb_set(snapshot,array['workerDays','0',field],to_jsonb(total::numeric/100));end loop;
 return snapshot;
end; $$;

set local role service_role;
do $$ declare a jsonb; positive jsonb; point jsonb; s jsonb; claimed jsonb; attempt uuid; token uuid; begin
 -- Distinct point occurrences at the same exported minute are one exact approval.
 a:=pg_temp.approve(pg_temp.precision_snapshot(array[21,22]));
 if (a#>>'{snapshot,totalHourHundredths}')::integer<>3 or jsonb_array_length(a#>'{snapshot,entries}')<>2 then raise exception 'same-approval point occurrences lost';end if;
 if (select count(*)from public.labor_job_hour_reservations r where r.approval_id=(a->>'id')::uuid and r.start_minute=480 and r.end_minute=480)<>2 then raise exception 'point reservations changed clocks or removed source IDs';end if;
 if a#>>'{snapshot,entries,0,clockIn}'<>'08:00' or a#>>'{snapshot,entries,0,clockOut}'<>'08:00' or a#>>'{snapshot,entries,0,sourceFileSha256}'<>repeat('a',64) then raise exception 'point source provenance changed';end if;
 -- Same-minute points cannot be approved again in another range/approval.
 begin perform pg_temp.approve(pg_temp.precision_snapshot(array[21]));raise exception 'cross-approval point occurrence double-reserved';exception when others then if sqlerrm<>'labor_approval_duplicate_interval' then raise;end if;end;
 s:=jsonb_set(pg_temp.precision_snapshot(array[21]),'{entries,0,reviewReasons}','[]');
 begin perform pg_temp.approve(s);raise exception 'point precision warning absent from approved bytes';exception when others then if sqlerrm<>'labor_approval_invalid_snapshot' then raise;end if;end;
 -- Equal positive-span boundaries are allowed; strict interior points conflict.
 positive:=pg_temp.approve(pg_temp.precision_snapshot(array[23]));
 begin perform pg_temp.approve(pg_temp.precision_snapshot(array[24]));raise exception 'point strictly inside positive span accepted';exception when others then if sqlerrm<>'labor_approval_duplicate_interval' then raise;end if;end;
 point:=pg_temp.approve(pg_temp.precision_snapshot(array[25]));
 perform pg_temp.approve(pg_temp.precision_snapshot(array[26]));
 perform pg_temp.approve(pg_temp.precision_snapshot(array[27]));
 perform pg_temp.approve(pg_temp.precision_snapshot(array[28]));
 -- The reverse ordering (point first, covering positive span later) also blocks.
 perform public.invalidate_labor_job_hour_approval((positive->>'id')::uuid,'93000000-0000-4000-8000-000000000001');
 point:=pg_temp.approve(pg_temp.precision_snapshot(array[24]));
 begin perform pg_temp.approve(pg_temp.precision_snapshot(array[23]));raise exception 'positive span covering reserved point accepted';exception when others then if sqlerrm<>'labor_approval_duplicate_interval' then raise;end if;end;
 perform public.invalidate_labor_job_hour_approval((point->>'id')::uuid,'93000000-0000-4000-8000-000000000001');
 -- Zero rows stay in source data but are not a valid positive approval interval.
 begin perform pg_temp.approve(pg_temp.precision_snapshot(array[31]));raise exception 'zero source row became approved hours';exception when others then if sqlerrm<>'labor_approval_invalid_snapshot' then raise;end if;end;
 begin perform pg_temp.approve(pg_temp.precision_snapshot(array[29]));raise exception 'large equal-clock interval accepted';exception when others then if sqlerrm<>'labor_approval_invalid_snapshot' then raise;end if;end;
 begin perform pg_temp.approve(pg_temp.precision_snapshot(array[30]));raise exception 'reverse clock interval accepted';exception when others then if sqlerrm<>'labor_approval_invalid_snapshot' then raise;end if;end;
 if not exists(select 1 from public.labor_source_imports i cross join lateral jsonb_array_elements(i.report->'entries')e where e->>'id'='TEST_ROW_31' and (e->>'hours')::numeric=0)then raise exception 'zero source row deleted';end if;
 -- Existing immutable dispatch/uncertainty authority also applies to point rows.
 claimed:=public.claim_labor_job_hour_send((a->>'id')::uuid,a->>'snapshot_hash',1,'93000000-0000-4000-8000-000000000001');
 attempt:=(claimed#>>'{attempt,id}')::uuid;token:=(claimed#>>'{attempt,lease_token}')::uuid;
 if public.mark_labor_job_hour_dispatched((a->>'id')::uuid,attempt,token)->>'allowed'<>'true' then raise exception 'point dispatch lease failed';end if;
 a:=public.finish_labor_job_hour_attempt((a->>'id')::uuid,attempt,token,'{"status":"sent","providerReference":"TEST_POINT_REFERENCE"}');
 begin perform public.invalidate_labor_job_hour_approval((a->>'id')::uuid,'93000000-0000-4000-8000-000000000001');raise exception 'sent point reservation revoked';exception when others then if sqlerrm<>'labor_approval_dispatch_uncertain' then raise;end if;end;
 update public.labor_state set control=jsonb_set(control,'{jobMappings,0,housecallJobId}','"job_remapped_test"')where singleton;
 begin perform pg_temp.approve(pg_temp.precision_snapshot(array[21],'job_remapped_test'));raise exception 'remap bypassed sent point reservation';exception when others then if sqlerrm<>'labor_approval_duplicate_interval' then raise;end if;end;
end; $$;
rollback;
