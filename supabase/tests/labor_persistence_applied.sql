-- Rollback-only checks. No provider calls, real payroll changes or persistent test users.
begin;
insert into auth.users(id,aud,role,email,raw_app_meta_data) values
 ('92000000-0000-4000-8000-000000000001','authenticated','authenticated','labor-manager@example.invalid','{"svl_access_approved":true}'),
 ('92000000-0000-4000-8000-000000000002','authenticated','authenticated','labor-admin@example.invalid','{"svl_access_approved":true}'),
 ('92000000-0000-4000-8000-000000000003','authenticated','authenticated','labor-worker@example.invalid','{"svl_access_approved":true}'),
 ('92000000-0000-4000-8000-000000000004','authenticated','authenticated','labor-disabled@example.invalid','{"svl_access_approved":true}');
update public.profiles set role='manager' where id in ('92000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000004');
update public.profiles set role='admin' where id='92000000-0000-4000-8000-000000000002';
update public.profiles set disabled=true where id='92000000-0000-4000-8000-000000000004';
-- The transaction resets only its temporary view of labor state; rollback restores any existing ledger.
update public.labor_state set revision=0,control=null where singleton;
update public.labor_source_imports set active=false;
update public.labor_worker_sessions set version=0,object_key=null,content_sha256=null where singleton;

do $$ declare item record; begin
 for item in select unnest(array['labor_state','labor_source_imports','labor_control_events','labor_worker_sessions']) name loop
  if not (select relrowsecurity from pg_class where oid=('public.'||item.name)::regclass)
   then raise exception 'labor RLS missing: %',item.name; end if;
  if has_table_privilege('anon','public.'||item.name,'SELECT') or has_table_privilege('authenticated','public.'||item.name,'INSERT')
   or has_table_privilege('authenticated','public.'||item.name,'UPDATE') or has_table_privilege('authenticated','public.'||item.name,'DELETE')
   then raise exception 'labor public write or anonymous read granted: %',item.name; end if;
 end loop;
 if to_regprocedure('public.compare_and_swap_labor_worker_session(bigint,text,text)') is not null
 then raise exception 'unfenced session RPC overload survived'; end if;
 if has_table_privilege('authenticated','public.labor_worker_sessions','SELECT')
  or has_table_privilege('service_role','public.labor_control_events','UPDATE')
  or has_table_privilege('service_role','public.labor_control_events','DELETE')
  or has_function_privilege('authenticated','public.compare_and_swap_labor_state(bigint,jsonb,jsonb,jsonb,uuid)','EXECUTE')
  or has_function_privilege('anon','public.read_labor_state(bigint)','EXECUTE')
  or has_function_privilege('authenticated','public.compare_and_swap_labor_worker_session(bigint,text,text,text)','EXECUTE')
  or has_function_privilege('authenticated','public.compare_and_swap_labor_state_leased(bigint,jsonb,jsonb,jsonb,text,text,date,date)','EXECUTE')
  or has_function_privilege('anon','public.compare_and_swap_labor_state_leased(bigint,jsonb,jsonb,jsonb,text,text,date,date)','EXECUTE')
 then raise exception 'labor privileged API leaked'; end if;
 if exists(select 1 from pg_proc where oid in ('public.compare_and_swap_labor_state(bigint,jsonb,jsonb,jsonb,uuid)'::regprocedure,
  'public.read_labor_state(bigint)'::regprocedure,'public.compare_and_swap_labor_worker_session(bigint,text,text,text)'::regprocedure,
  'public.compare_and_swap_labor_state_leased(bigint,jsonb,jsonb,jsonb,text,text,date,date)'::regprocedure) and prosecdef)
 then raise exception 'labor public RPC unexpectedly bypasses caller grants'; end if;
end; $$;

set local role service_role;
do $$ declare first_control jsonb; source jsonb; sources jsonb; snapshot jsonb; events_before bigint; source_updated text; begin
 if public.read_labor_state() is not null then raise exception 'empty ledger returned initialized state'; end if;
 first_control:='{"version":1,"sync":{"hour":6,"status":"connected","workerHeartbeatAt":"2026-10-13T00:00:00Z"},"workerLease":{"leaseToken":"TEST-private-lease","expiresAt":"2026-10-13T00:01:00Z"},"rulesRevision":0,"paySettings":{"workerRates":[{"workerName":"TEST worker","hourlyRate":25}]}}';
 source:=jsonb_build_object('id','92000000-0000-4000-8000-000000000011','kind','timesheet','position',0,
  'file_sha256',repeat('a',64),'content_hash',repeat('b',64),'summary',jsonb_build_object('filename','TEST.xlsx'),
  'report',jsonb_build_object('entries',jsonb_build_array(jsonb_build_object('workerName','TEST worker','hours',8))));
 sources:=jsonb_build_array(source-'file_sha256'-'summary'-'report');
 if public.compare_and_swap_labor_state(0,first_control,sources,jsonb_build_array(source),'92000000-0000-4000-8000-000000000001')<>1
 then raise exception 'initial labor CAS failed'; end if;
 snapshot:=public.read_labor_state();
 if snapshot->>'revision'<>'1' or snapshot->'state'->'imports'->0->>'hash'<>repeat('a',64)
  or snapshot->'state'->'imports'->0->'report'->'entries'->0->>'hours'<>'8'
  or jsonb_array_length(snapshot->'state'->'notesImports')<>0
  or (select control ? 'imports' from public.labor_state where singleton)
 then raise exception 'split snapshot reconstruction failed'; end if;
 if public.read_labor_state(1)<>jsonb_build_object('revision',1,'unchanged',true)
 then raise exception 'unchanged snapshot retransmitted source reports'; end if;
 select count(*) into events_before from public.labor_control_events;
 select updated_at::text into source_updated from public.labor_source_imports where id='92000000-0000-4000-8000-000000000011';
 first_control:=jsonb_set(first_control,'{sync,workerHeartbeatAt}','"2026-10-13T00:00:15Z"');
 first_control:=jsonb_set(first_control,'{workerLease,expiresAt}','"2026-10-13T00:01:15Z"');
 if public.compare_and_swap_labor_state(1,first_control,sources,'[]',null)<>2
 then raise exception 'heartbeat CAS failed'; end if;
 if (select count(*) from public.labor_control_events)<>events_before
  or (select updated_at::text from public.labor_source_imports where id='92000000-0000-4000-8000-000000000011')<>source_updated
 then raise exception 'heartbeat rewrote source reports or grew the control audit'; end if;
 if exists(select 1 from public.labor_control_events where details::text like '%TEST-private-lease%' or details ? 'workerLease'
  or details->'previousControl' ? 'workerLease' or details->'resultingControl' ? 'workerLease')
 then raise exception 'worker lease credentials leaked to audit'; end if;
 if public.compare_and_swap_labor_state(1,'{"version":999}',sources,'[]',null) is not null
  or (select control->>'version' from public.labor_state where singleton)<>'1'
 then raise exception 'stale writer overwrote state'; end if;
 begin
  perform public.compare_and_swap_labor_state(2,first_control,sources,'[]','92000000-0000-4000-8000-000000000003');
  raise exception 'worker actor accepted';
 exception when others then if sqlerrm<>'forbidden' then raise; end if; end;
 begin
  perform public.compare_and_swap_labor_state(2,first_control,sources,'[]','92000000-0000-4000-8000-000000000004');
  raise exception 'disabled actor accepted';
 exception when others then if sqlerrm<>'unauthenticated' then raise; end if; end;
 begin
  perform public.compare_and_swap_labor_state(2,first_control,jsonb_build_array((sources->0)||jsonb_build_object('content_hash',repeat('c',64))),'[]',null);
  raise exception 'missing changed source accepted';
 exception when others then if sqlerrm<>'labor_source_delta_incomplete' then raise; end if; end;
 if (select revision from public.labor_state where singleton)<>2 then raise exception 'invalid delta partly committed'; end if;
 source:=source || jsonb_build_object('file_sha256',repeat('c',64),'content_hash',repeat('c',64));
 begin
  perform public.compare_and_swap_labor_state(2,first_control,jsonb_build_array(source-'file_sha256'-'summary'-'report'),jsonb_build_array(source),null);
  raise exception 'original source identity changed';
 exception when others then if sqlerrm<>'labor_source_identity_changed' then raise; end if; end;
 -- A configuration edit is attributed to the active administrator and audited once.
 first_control:=jsonb_set(first_control,'{rulesRevision}','1');
 if public.compare_and_swap_labor_state(2,first_control,sources,'[]','92000000-0000-4000-8000-000000000002')<>3
 then raise exception 'configuration CAS failed'; end if;
 if not exists(select 1 from public.labor_control_events where revision=3 and actor_id='92000000-0000-4000-8000-000000000002' and changed_keys=array['rulesRevision'])
 then raise exception 'configuration audit missing actor or changed fields'; end if;
 -- Pruning drops rebuildable JSON while retaining immutable original identity and provenance.
 if public.compare_and_swap_labor_state(3,first_control,'[]','[]',null)<>4
 then raise exception 'prune CAS failed'; end if;
 if not exists(select 1 from public.labor_source_imports where id='92000000-0000-4000-8000-000000000011' and not active and report is null and file_sha256=repeat('a',64) and summary->>'filename'='TEST.xlsx')
 then raise exception 'prune deleted source provenance'; end if;
end; $$;
-- The worker commit gate validates the live lease and requested scope while locked.
do $$ declare test_control jsonb; proposed jsonb; source jsonb; manifest jsonb; before_events bigint;
 token text:='92000000-0000-4000-8000-000000000031'; command text:='92000000-0000-4000-8000-000000000032';
 begin
 select labor_state.control into test_control from public.labor_state where singleton;
 test_control:=test_control || jsonb_build_object('sync',(test_control->'sync') || jsonb_build_object('status','running','commandId',command),
  'workerLease',jsonb_build_object('leaseToken',token,'commandId',command,'period',jsonb_build_object('from','2026-09-24','to','2026-09-30'),
   'expiresAt',clock_timestamp()+interval '1 hour','imported',false));
 update public.labor_state set control=test_control where singleton;
 proposed:=jsonb_set(test_control,'{workerLease,imported}','true');
 source:=jsonb_build_object('id','92000000-0000-4000-8000-000000000021','kind','timesheet','position',0,
  'file_sha256',repeat('f',64),'content_hash',repeat('f',64),'summary',jsonb_build_object('filename','TEST-leased.xlsx'),
  'report',jsonb_build_object('entries',jsonb_build_array(jsonb_build_object('workerName','TEST worker','hours',9))));
 manifest:=jsonb_build_array(source-'file_sha256'-'summary'-'report');
 select count(*) into before_events from public.labor_control_events;
 if public.compare_and_swap_labor_state_leased(4,proposed,manifest,jsonb_build_array(source),'92000000-0000-4000-8000-000000000033',command,'2026-09-24','2026-09-30') is not null
  or public.compare_and_swap_labor_state_leased(4,proposed,manifest,jsonb_build_array(source),token,'92000000-0000-4000-8000-000000000033','2026-09-24','2026-09-30') is not null
  or public.compare_and_swap_labor_state_leased(4,proposed,manifest,jsonb_build_array(source),token,command,'2026-09-25','2026-09-30') is not null
  or public.compare_and_swap_labor_state_leased(4,jsonb_set(proposed,'{workerLease,leaseToken}','"forged"'),manifest,jsonb_build_array(source),token,command,'2026-09-24','2026-09-30') is not null
  or public.compare_and_swap_labor_state_leased(3,proposed,manifest,jsonb_build_array(source),token,command,'2026-09-24','2026-09-30') is not null
 then raise exception 'invalid leased import identity, scope, proposed test_control or revision accepted'; end if;
 update public.labor_state set control=jsonb_set(test_control,'{workerLease,expiresAt}',to_jsonb(clock_timestamp()-interval '1 second')) where singleton;
 if public.compare_and_swap_labor_state_leased(4,proposed,manifest,jsonb_build_array(source),token,command,'2026-09-24','2026-09-30') is not null
 then raise exception 'expired worker imported reports'; end if;
 update public.labor_state set control=jsonb_set(test_control,'{sync,status}','"idle"') where singleton;
 if public.compare_and_swap_labor_state_leased(4,proposed,manifest,jsonb_build_array(source),token,command,'2026-09-24','2026-09-30') is not null
 then raise exception 'nonrunning worker imported reports'; end if;
 if (select revision from public.labor_state where singleton)<>4 or (select count(*) from public.labor_control_events)<>before_events
  or exists(select 1 from public.labor_source_imports where id='92000000-0000-4000-8000-000000000021')
 then raise exception 'rejected leased import changed audit or source data'; end if;
 update public.labor_state set control=test_control where singleton;
 if public.compare_and_swap_labor_state_leased(4,proposed,manifest,jsonb_build_array(source),token,command,'2026-09-24','2026-09-30')<>5
 then raise exception 'live leased import failed'; end if;
 if not exists(select 1 from public.labor_source_imports where id='92000000-0000-4000-8000-000000000021' and active)
  or not (select control#>'{workerLease,imported}'='true'::jsonb from public.labor_state where singleton)
 then raise exception 'leased source or imported marker did not commit'; end if;
 -- Existing manager CAS still works without a worker guard and retains its audit actor.
 proposed:=jsonb_set(proposed,'{rulesRevision}','2');
 if public.compare_and_swap_labor_state(5,proposed,manifest,'[]','92000000-0000-4000-8000-000000000002')<>6
  then raise exception 'manager CAS compatibility failed'; end if;
 if not exists(select 1 from public.labor_control_events where revision=6 and actor_id='92000000-0000-4000-8000-000000000002')
  then raise exception 'manager CAS audit actor lost'; end if;
end; $$;
reset role;

-- Even the table owner cannot rewrite audited events through ordinary DML.
do $$ begin
 begin update public.labor_control_events set details='{}' where revision=3; raise exception 'labor audit update allowed';
 exception when insufficient_privilege then null; end;
 begin delete from public.labor_control_events where revision=3; raise exception 'labor audit deletion allowed';
 exception when insufficient_privilege then null; end;
end; $$;

set local role authenticated;
select set_config('request.jwt.claim.sub','92000000-0000-4000-8000-000000000003',true);
do $$ begin
 if exists(select 1 from public.labor_state) or exists(select 1 from public.labor_source_imports) or exists(select 1 from public.labor_control_events)
 then raise exception 'worker read staff hours or pay rates'; end if;
 begin perform public.read_labor_state(); raise exception 'worker invoked privileged snapshot'; exception when insufficient_privilege then null; end;
end; $$;
select set_config('request.jwt.claim.sub','92000000-0000-4000-8000-000000000004',true);
do $$ begin if exists(select 1 from public.labor_state) then raise exception 'disabled manager read labor state'; end if; end; $$;
select set_config('request.jwt.claim.sub','92000000-0000-4000-8000-000000000001',true);
do $$ begin
 if not exists(select 1 from public.labor_state where control->'paySettings'->'workerRates'->0->>'hourlyRate'='25')
  or not exists(select 1 from public.labor_source_imports where id='92000000-0000-4000-8000-000000000011')
 then raise exception 'active manager cannot read reviewed labor evidence'; end if;
 begin update public.labor_state set control='{}'; raise exception 'manager wrote state directly'; exception when insufficient_privilege then null; end;
end; $$;
select set_config('request.jwt.claim.sub','92000000-0000-4000-8000-000000000002',true);
do $$ begin if not exists(select 1 from public.labor_control_events where revision=3) then raise exception 'admin cannot read audit'; end if; end; $$;
reset role;

-- Count private labor originals/sessions in quota usage, preserving receipt-specific metrics.
select set_config('labor.test_storage_bytes',(select storage_bytes::text from svl_ops.storage_capacity_snapshot()),true);
select set_config('labor.test_receipt_bytes',(select confirmed_page_bytes::text from svl_ops.storage_capacity_snapshot()),true);
insert into storage.objects(bucket_id,name,metadata) values
 ('labor-originals','92000000-0000-4000-8000-000000000011.xlsx','{"size":321}'),
 ('labor-worker-sessions','92000000-0000-4000-8000-000000000012.bin','{"size":123}');
do $$ begin
 if (select storage_bytes from svl_ops.storage_capacity_snapshot())<>current_setting('labor.test_storage_bytes')::bigint+444
  or (select confirmed_page_bytes from svl_ops.storage_capacity_snapshot())<>current_setting('labor.test_receipt_bytes')::bigint
 then raise exception 'labor storage absent from shared quota or receipt metrics changed'; end if;
end; $$;

-- Prove the restrictive bucket guard survives an unrelated permissive policy.
create policy labor_test_permissive on storage.objects for select to authenticated using(true);
set local role authenticated;
select set_config('request.jwt.claim.sub','92000000-0000-4000-8000-000000000002',true);
do $$ begin
 if exists(select 1 from storage.objects where bucket_id in ('labor-originals','labor-worker-sessions'))
 then raise exception 'private labor storage escaped through permissive policy'; end if;
end; $$;
reset role;
set local role service_role;
do $$ begin
 -- A null token is restricted to an explicit connection command without a live lease.
 if public.compare_and_swap_labor_worker_session(0,'92000000-0000-4000-8000-000000000012.bin',repeat('d',64),null) is not null
 then raise exception 'session bootstrap accepted without queued connection'; end if;
 update public.labor_state set control=control || jsonb_build_object('sync',jsonb_build_object('command','connect'),
  'workerLease',jsonb_build_object('leaseToken','TEST-live-lease','expiresAt',clock_timestamp()+interval '1 hour')) where singleton;
 if public.compare_and_swap_labor_worker_session(0,'92000000-0000-4000-8000-000000000012.bin',repeat('d',64),null) is not null
 then raise exception 'session bootstrap replaced active lease'; end if;
 update public.labor_state set control=jsonb_set(control,'{workerLease,expiresAt}',to_jsonb(clock_timestamp()-interval '1 second')) where singleton;
 if public.compare_and_swap_labor_worker_session(0,'92000000-0000-4000-8000-000000000012.bin',repeat('d',64),null)<>1
 then raise exception 'session initialization failed'; end if;
 if public.compare_and_swap_labor_worker_session(0,'92000000-0000-4000-8000-000000000012.bin',repeat('e',64),null) is not null
  or (select content_sha256 from public.labor_worker_sessions where singleton)<>repeat('d',64)
 then raise exception 'stale worker replaced valid encrypted session'; end if;
 -- Running workers must present the current live lease for the current command.
 update public.labor_state set control=control || jsonb_build_object('sync',jsonb_build_object('status','running','commandId','TEST-command'),
  'workerLease',jsonb_build_object('leaseToken','TEST-live-lease','commandId','TEST-command','expiresAt',clock_timestamp()+interval '1 hour')) where singleton;
 if public.compare_and_swap_labor_worker_session(1,'92000000-0000-4000-8000-000000000012.bin',repeat('e',64),'TEST-wrong-lease') is not null
 then raise exception 'wrong session lease accepted'; end if;
 update public.labor_state set control=jsonb_set(control,'{workerLease,expiresAt}',to_jsonb(clock_timestamp()-interval '1 second')) where singleton;
 if public.compare_and_swap_labor_worker_session(1,'92000000-0000-4000-8000-000000000012.bin',repeat('e',64),'TEST-live-lease') is not null
 then raise exception 'expired session lease accepted'; end if;
 update public.labor_state set control=jsonb_set(control,'{workerLease,expiresAt}',to_jsonb(clock_timestamp()+interval '1 hour')) where singleton;
 update public.labor_state set control=jsonb_set(control,'{sync,commandId}','"TEST-other-command"') where singleton;
 if public.compare_and_swap_labor_worker_session(1,'92000000-0000-4000-8000-000000000012.bin',repeat('e',64),'TEST-live-lease') is not null
 then raise exception 'superseded command session accepted'; end if;
 update public.labor_state set control=jsonb_set(control,'{sync,commandId}','"TEST-command"') where singleton;
 update public.labor_state set control=jsonb_set(control,'{sync,status}','"connected"') where singleton;
 if public.compare_and_swap_labor_worker_session(1,'92000000-0000-4000-8000-000000000012.bin',repeat('e',64),'TEST-live-lease') is not null
 then raise exception 'non-running worker session accepted'; end if;
 update public.labor_state set control=jsonb_set(control,'{sync,status}','"running"') where singleton;
 if public.compare_and_swap_labor_worker_session(1,'92000000-0000-4000-8000-000000000012.bin',repeat('e',64),'TEST-live-lease')<>2
 then raise exception 'current leased worker session rejected'; end if;
 begin
  perform public.compare_and_swap_labor_worker_session(2,'92000000-0000-4000-8000-000000000099.bin',repeat('e',64),'TEST-live-lease');
  raise exception 'session pointer accepted missing encrypted object';
 exception when others then if sqlerrm<>'labor_worker_session_upload_missing' then raise; end if; end;
end; $$;
reset role;
rollback;
