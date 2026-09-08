-- Full manager transactions, durable intents, role boundaries and recovery.
begin;
insert into auth.users(id,aud,role,email) values
('44000000-0000-4000-8000-000000000001','authenticated','authenticated','ra4-worker@example.invalid'),
('44000000-0000-4000-8000-000000000002','authenticated','authenticated','ra4-manager@example.invalid'),
('44000000-0000-4000-8000-000000000003','authenticated','authenticated','ra4-admin@example.invalid'),
('44000000-0000-4000-8000-000000000004','authenticated','authenticated','ra4-disabled@example.invalid');
update public.profiles set role='manager' where id in ('44000000-0000-4000-8000-000000000002','44000000-0000-4000-8000-000000000004');
update public.profiles set role='admin' where id='44000000-0000-4000-8000-000000000003';
update public.profiles set disabled=true where id='44000000-0000-4000-8000-000000000004';
insert into public.receipts(id,owner_user_id,status,submitted_at)
select ('44100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'44000000-0000-4000-8000-000000000001','needs_review',now() from generate_series(1,6)n;
insert into public.manager_job_catalog(id,label,customer,job_number) values ('ra4-job-a','Same display name','Riverside customer','1042'),('ra4-job-b','Same display name','Orchard customer','1043');
insert into public.extractions(id,receipt_id,provider,vendor) values ('44200000-0000-4000-8000-000000000001','44100000-0000-4000-8000-000000000001','gemini','Original vendor');
-- RA-5 requires a configured category ID; this is rollback-only test configuration.
insert into public.receipt_categories(id,label,active) values('Materials','Materials',true);
set local role service_role;
do $$
declare
 manager uuid:='44000000-0000-4000-8000-000000000002'; admin_id uuid:='44000000-0000-4000-8000-000000000003';
 receipt uuid:='44100000-0000-4000-8000-000000000001'; ext uuid:='44200000-0000-4000-8000-000000000001';
 draft jsonb:='{"vendor":"Corrected vendor","purchaseDate":"2026-09-07","invoiceNumber":"INV-4","ticketNumber":"","category":"Materials","referenceTotal":"99.00","managerNotes":"","lines":[{"description":"Copper","qty":"1.005","uom":"ft","unitCost":"1.00","jobId":"ra4-job-a"},{"description":"Wood","qty":"2","uom":"ea","unitCost":"3.25","jobId":"ra4-job-b"}]}';
 r jsonb; bad jsonb; intent uuid; line_id uuid; attempt uuid; result_id uuid;
begin
 r:=public.manager_review_command(receipt,manager,0,ext,'save_draft',draft);
 if (r->>'version')::int<>1 or exists(select 1 from public.housecall_outbox where receipt_id=receipt) then raise exception 'draft must version without exporting'; end if;
 if (select vendor from public.extractions where id=ext)<>'Original vendor' then raise exception 'immutable extraction changed'; end if;
 begin perform public.manager_review_command(receipt,manager,0,ext,'save_draft',draft);raise exception 'stale write accepted'; exception when others then if sqlerrm<>'conflict_stale_review' then raise;end if;end;
 begin perform public.manager_review_command(receipt,manager,1,null,'approve',draft);raise exception 'stale extraction accepted'; exception when others then if sqlerrm<>'conflict_stale_review' then raise;end if;end;
 foreach bad in array array[jsonb_set(draft,'{lines,0,qty}','"-1"'),jsonb_set(draft,'{lines,0,unitCost}','"1.001"'),jsonb_set(draft,'{lines,0,jobId}','"overhead"'),jsonb_set(draft,'{vendor}','""')] loop
  begin perform public.manager_review_command(receipt,manager,1,ext,'approve',bad);raise exception 'invalid approval accepted';exception when others then if sqlerrm not like 'invalid_request%' then raise;end if;end;
 end loop;
 if (select review_version from public.receipts where id=receipt)<>1 then raise exception 'invalid transaction partially committed';end if;
 r:=public.manager_review_command(receipt,manager,1,ext,'request_clarification',draft,'Please confirm quantity');
 if (select clarification_reason from public.receipts where id=receipt)<>'Please confirm quantity' then raise exception 'worker reason missing';end if;
 if r->>'status'<>'needs_review' or exists(select 1 from public.housecall_outbox where receipt_id=receipt) then raise exception 'clarification exported or changed locked worker lifecycle';end if;
 r:=public.manager_review_command(receipt,manager,2,ext,'approve',draft);intent:=(r->>'intentId')::uuid;
 if r->>'status'<>'approved' or (select count(*) from public.housecall_outbox where receipt_id=receipt)<>1 or not exists(select 1 from public.work_items where receipt_id=receipt and kind='export' and status='queued') then raise exception 'approval not atomic';end if;
 if (select job_cost_lines->0->>'extended_cost_cents' from public.housecall_intents where id=intent)<>'101' or (select jsonb_array_length(attachment_job_ids) from public.housecall_intents where id=intent)<>2 then raise exception 'decimal or split wrong';end if;
 if (select job_cost_lines::text from public.housecall_intents where id=intent) like '%9900%' then raise exception 'reference total allocated into cost';end if;
 begin perform public.manager_review_command(receipt,manager,3,ext,'approve',draft);raise exception 'double approval accepted';exception when others then if sqlerrm<>'conflict' then raise;end if;end;
 select id into line_id from public.receipt_lines where receipt_id=receipt and sort_index=1;
 insert into public.export_attempts(receipt_id,intent_id,housecall_job_id,step,status,idempotency_key) values(receipt,intent,'ra4-job-a','attachment','succeeded','ra4-success');
 insert into public.export_attempts(receipt_id,intent_id,receipt_line_id,housecall_job_id,step,status,idempotency_key,error_code) values(receipt,intent,line_id,'ra4-job-b','job_cost','retryable_failure','ra4-failure','timeout') returning id into attempt;
 r:=public.manager_recovery_command(receipt,manager,intent,'retry',attempt,'Retry after reconciliation');result_id:=(r->>'id')::uuid;
 r:=public.manager_recovery_command(receipt,manager,intent,'retry',attempt,'Second click');
 if (r->>'id')::uuid<>result_id or (select count(*) from public.manager_recovery_commands where attempt_id=attempt)<>1 then raise exception 'duplicate retry command';end if;
 if (select count(*) from public.export_attempts where receipt_id=receipt)<>2 then raise exception 'retry mutated external attempt history';end if;
 update public.manager_recovery_commands set status='completed' where id=result_id;
 insert into public.export_attempts(receipt_id,intent_id,receipt_line_id,housecall_job_id,step,status,idempotency_key) values(receipt,intent,line_id,'ra4-job-b','job_cost','succeeded','ra4-late-success');
 begin perform public.manager_recovery_command(receipt,manager,intent,'retry',attempt,'Stale failed step');raise exception 'succeeded step retry accepted';exception when others then if sqlerrm<>'conflict' then raise;end if;end;
 begin perform public.manager_recovery_command(receipt,manager,intent,'correction',null,'Changed qty',jsonb_set(draft,'{lines,0,qty}','"2"'));raise exception 'manager correction accepted';exception when others then if sqlerrm<>'forbidden' then raise;end if;end;
 r:=public.manager_recovery_command(receipt,admin_id,intent,'correction',null,'Changed qty',jsonb_set(draft,'{lines,0,qty}','"2"'));
 if (select qty from public.receipt_lines where receipt_id=receipt and sort_index=0)<>1.005 or (select count(*) from public.housecall_intents where receipt_id=receipt)<>1 then raise exception 'correction silently rewrote posted history';end if;
 if not exists(select 1 from public.audit_events where receipt_id=receipt and actor_id=manager and action='review_recorded') then raise exception 'audit actor missing';end if;
 begin perform public.manager_review_command('44100000-0000-4000-8000-000000000002','44000000-0000-4000-8000-000000000001',0,null,'save_draft',draft);raise exception 'worker mutation accepted';exception when others then if sqlerrm<>'forbidden' then raise;end if;end;
 begin perform public.manager_review_command('44100000-0000-4000-8000-000000000002','44000000-0000-4000-8000-000000000004',0,null,'save_draft',draft);raise exception 'disabled mutation accepted';exception when others then if sqlerrm<>'unauthenticated' then raise;end if;end;
 begin perform public.manager_review_command('44100000-0000-4000-8000-000000000002',manager,0,null,'decline',draft,'');raise exception 'reasonless decline accepted';exception when others then if sqlerrm<>'invalid_request_reason' then raise;end if;end;
 r:=public.manager_review_command('44100000-0000-4000-8000-000000000002',manager,0,null,'decline',draft,'Not a business purchase');
 if (select retention_started_at from public.receipts where id='44100000-0000-4000-8000-000000000002') is null then raise exception 'decline retention not started';end if;
 begin perform public.manager_review_command('44100000-0000-4000-8000-000000000003',manager,0,null,'mark_duplicate',draft,'Duplicate','44100000-0000-4000-8000-000000000003');raise exception 'self duplicate accepted';exception when others then if sqlerrm<>'invalid_request_canonical' then raise;end if;end;
 r:=public.manager_review_command('44100000-0000-4000-8000-000000000003',manager,0,null,'mark_duplicate',draft,'Duplicate copy',receipt);
 if exists(select 1 from public.housecall_outbox where receipt_id in ('44100000-0000-4000-8000-000000000002','44100000-0000-4000-8000-000000000003')) then raise exception 'non-approval exported';end if;
end;$$;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','44000000-0000-4000-8000-000000000002',true);
do $$
declare events jsonb[]; first_event jsonb; next_event jsonb;
begin
 if has_function_privilege('authenticated','public.manager_review_command(uuid,uuid,integer,uuid,text,jsonb,text,uuid)','EXECUTE') or has_table_privilege('authenticated','public.manager_recovery_commands','INSERT') then raise exception 'direct mutations granted';end if;
 if (select count(*) from public.manager_search_jobs('Same display name',true,50))<>2 then raise exception 'duplicate job labels collapsed';end if;
 if (select count(*) from public.manager_review_queue(p_tab=>'history',p_search=>'Riverside customer'))<>1 then raise exception 'history missing final job customer';end if;
 if (select jsonb_array_length(q->'assignedJobs') from public.manager_review_queue(p_tab=>'history',p_search=>'Riverside customer')q)<>2 then raise exception 'final job assignments missing';end if;
 if public.manager_legacy_review_edits('44100000-0000-4000-8000-000000000001')->>'vendor'<>'Corrected vendor' then raise exception 'legacy edit projection failed';end if;
 select array_agg(e) into events from public.manager_receipt_timeline('44100000-0000-4000-8000-000000000001',null,null,51)e;
 if cardinality(events)<10 or not exists(select 1 from unnest(events)e where e->>'action'='approve') then raise exception 'audit timeline incomplete';end if;
 select e into first_event from public.manager_receipt_timeline('44100000-0000-4000-8000-000000000001',null,null,1)e;
 select e into next_event from public.manager_receipt_timeline('44100000-0000-4000-8000-000000000001',(first_event->>'createdAt')::timestamptz,(first_event->>'id')::uuid,1)e;
 if next_event is null or first_event->>'id'=next_event->>'id' then raise exception 'timeline pagination failed';end if;
end;$$;
select set_config('request.jwt.claim.sub','44000000-0000-4000-8000-000000000001',true);
do $$begin
 if (select count(*) from public.manager_job_catalog)<>0 then raise exception 'worker job leak';end if;
 begin perform public.manager_receipt_timeline('44100000-0000-4000-8000-000000000001');raise exception 'worker timeline leak';exception when others then if sqlerrm<>'forbidden' then raise;end if;end;
end;$$;
reset role;
-- Purge clears all newly introduced sensitive manager content and hides history.
update public.receipts set content_deleted_at=now() where id='44100000-0000-4000-8000-000000000001';
do $$begin
 if exists(select 1 from public.manager_recovery_commands where receipt_id='44100000-0000-4000-8000-000000000001' and (before_snapshot is not null or proposed_snapshot is not null or reason<>'Content deleted')) then raise exception 'purged manager content remains';end if;
end;$$;
set local role authenticated;
select set_config('request.jwt.claim.sub','44000000-0000-4000-8000-000000000002',true);
do $$begin
 if exists(select 1 from public.manager_recovery_commands where receipt_id='44100000-0000-4000-8000-000000000001') then raise exception 'purged recovery exposed';end if;
 begin perform public.manager_receipt_timeline('44100000-0000-4000-8000-000000000001');raise exception 'purged timeline exposed';exception when others then if sqlerrm<>'forbidden' then raise;end if;end;
end;$$;
rollback;
