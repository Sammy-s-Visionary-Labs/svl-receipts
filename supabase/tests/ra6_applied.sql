-- RA-6 local-only contract tests. No HTTP or provider credentials are used.
begin;
insert into auth.users(id,aud,role,email) values
 ('66000000-0000-4000-8000-000000000001','authenticated','authenticated','ra6-worker@example.invalid'),
 ('66000000-0000-4000-8000-000000000002','authenticated','authenticated','ra6-manager@example.invalid'),
 ('66000000-0000-4000-8000-000000000003','authenticated','authenticated','ra6-admin@example.invalid');
update public.profiles set role='manager' where id='66000000-0000-4000-8000-000000000002';
update public.profiles set role='admin' where id='66000000-0000-4000-8000-000000000003';
insert into public.receipt_categories(id,label) values('ra6-materials','RA6 materials');
insert into public.manager_job_catalog(id,label) values('ra6-job-a','RA6 Test A'),('ra6-job-b','RA6 Test B');
insert into public.receipts(id,owner_user_id,status,submitted_at)
 select ('66100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'66000000-0000-4000-8000-000000000001','needs_review',now() from generate_series(1,5)n;
insert into public.receipt_pages(receipt_id,page_index,storage_key,content_type,checksum,byte_size,confirmed_at)
 select r.id,p,'ra6-test/'||r.id||'/'||p||'.jpg','image/jpeg',repeat('a',64),100,now()
 from public.receipts r cross join generate_series(0,1)p where r.id::text like '66100000%' and r.id<>'66100000-0000-4000-8000-000000000005';
set local role service_role;
do $$
declare
 manager uuid:='66000000-0000-4000-8000-000000000002'; admin_id uuid:='66000000-0000-4000-8000-000000000003';
 receipt uuid:='66100000-0000-4000-8000-000000000001'; receipt2 uuid:='66100000-0000-4000-8000-000000000002';
 snapshot jsonb:='{"vendor":"SYNTHETIC RA6 TEST","purchaseDate":"2026-09-09","invoiceNumber":"RA6-TEST-1","ticketNumber":"","category":"ra6-materials","referenceTotal":"999.99","managerNotes":"synthetic only","lines":[{"description":"Limestone","qty":"0.5","uom":"ton","unitCost":"42.00","jobId":"ra6-job-a"},{"description":"Fabric","qty":"2","uom":"ea","unitCost":"3.25","jobId":"ra6-job-b"}]}';
 approved jsonb; approved2 jsonb; intent uuid; intent2 uuid; digest text; claimed jsonb; claimed2 jsonb; s jsonb; g jsonb; finished jsonb; external text; step_id uuid; lease uuid; n integer:=0;
begin
 approved:=public.manager_review_command(receipt,manager,0,null,'approve',snapshot);
 approved2:=public.manager_review_command(receipt2,manager,0,null,'approve',snapshot);
 intent:=(approved->>'intentId')::uuid; intent2:=(approved2->>'intentId')::uuid;
 select payload_hash into digest from public.housecall_intents where id=intent;
 if digest is null or (select jsonb_array_length(approved_images) from public.housecall_intents where id=intent)<>2 then raise exception 'image snapshot missing'; end if;
 if (select count(*) from public.housecall_export_steps where intent_id=intent)<>6 then raise exception 'distinct page/job plans missing'; end if;
 if (select approved_reference from public.housecall_intents where id=intent)<>'SYNTHETIC RA6 TEST #RA6-TEST-1 2026-09-09'
  or exists(select 1 from public.housecall_export_steps where intent_id=intent and payload->>'approved_reference'<>'SYNTHETIC RA6 TEST #RA6-TEST-1 2026-09-09') then raise exception 'approved supplier reference not frozen';end if;
 if (select payload_hash from public.housecall_intents where id=intent) is distinct from
  (select public.housecall_payload_hash(jsonb_build_object('id',i.id,'receipt_id',i.receipt_id,'review_id',i.review_id,'payload_version',i.payload_version,
   'attachment_job_ids',i.attachment_job_ids,'job_cost_lines',i.job_cost_lines,'approved_images',i.approved_images,'approved_reference',i.approved_reference)) from public.housecall_intents i where i.id=intent)
  then raise exception 'supplier reference absent from immutable hash';end if;
 if exists(select 1 from public.housecall_export_steps where intent_id=intent and payload::text like '%99999%') then raise exception 'reference total exported'; end if;
 if (select sum((payload->'line'->>'extended_cost_cents')::numeric) from public.housecall_export_steps where intent_id=intent and step='job_cost')<>2750 then raise exception 'fractional quantity arithmetic'; end if;
 if exists(select 1 from public.housecall_write_approvals where intent_id=intent) then raise exception 'manager approval granted live writes'; end if;
 if exists(select 1 from public.list_ready_housecall_exports(20)) then raise exception 'unapproved receipt selected for live worker';end if;
 begin perform public.grant_housecall_write_approval(manager,intent,digest,array['ra6-job-a'],now()+interval '1 hour',10,'not authorized admin');raise exception 'manager granted live write';exception when others then if sqlerrm<>'forbidden' then raise;end if;end;
 begin perform public.grant_housecall_write_approval(admin_id,intent,repeat('0',64),array['ra6-job-a'],now()+interval '1 hour',10,'bad hash');raise exception 'wrong hash granted';exception when others then if sqlerrm<>'invalid_export_approval' then raise;end if;end;
 begin perform public.grant_housecall_write_approval(admin_id,intent,digest,array['real-customer-job'],now()+interval '1 hour',10,'wrong job');raise exception 'wrong job granted';exception when others then if sqlerrm<>'invalid_export_approval' then raise;end if;end;
 begin perform public.grant_housecall_write_approval(admin_id,intent,digest,array['ra6-job-a'],now()+interval '25 hours',10,'unbounded');raise exception 'unbounded approval granted';exception when others then if sqlerrm<>'invalid_export_approval' then raise;end if;end;
 claimed:=public.claim_housecall_export_step(intent,'test-worker'); s:=claimed->'step';
 if claimed is null or claimed->>'reconcileOnly'<>'false' then raise exception 'initial claim failed'; end if;
 begin perform public.manager_recovery_command(receipt,admin_id,intent,'correction',null,'Correction during RA6 lease',jsonb_set(snapshot,'{lines,0,qty}','"1"'));raise exception 'in-flight correction accepted';exception when others then if sqlerrm<>'conflict' then raise;end if;end;
 if exists(select 1 from public.manager_recovery_commands where receipt_id=receipt and kind='correction') then raise exception 'in-flight correction command persisted';end if;
 if public.claim_housecall_export_step(intent,'other-worker') is not null then raise exception 'receipt lease stolen'; end if;
 if public.claim_housecall_export_step(intent2,'other-receipt') is not null then raise exception 'destination lease stolen'; end if;
 begin perform public.consume_housecall_write_approval((s->>'id')::uuid,(s->>'lease_token')::uuid);raise exception 'unapproved write permitted';exception when others then if sqlerrm<>'live_write_approval_required' then raise;end if;end;
 if (select dispatch_started_at from public.housecall_export_steps where id=(s->>'id')::uuid) is not null then raise exception 'blocked dispatch marked attempted'; end if;
 finished:=public.finish_housecall_export_step((s->>'id')::uuid,(s->>'lease_token')::uuid,'not_sent',null,'approval_required');
 if finished->>'status'<>'ready' then raise exception 'unsent step not safely released'; end if;
 -- A one-write approval is consumed exactly once before HTTP would be sent.
 g:=public.grant_housecall_write_approval(admin_id,intent,digest,array['ra6-job-a'],now()+interval '1 hour',1,'explicit mock grant');
 if not exists(select 1 from public.list_ready_housecall_exports(20) q where q.intent_id=intent) then raise exception 'approved current work not selected';end if;
 claimed:=public.claim_housecall_export_step(intent,'test-worker'); s:=claimed->'step';step_id:=(s->>'id')::uuid;lease:=(s->>'lease_token')::uuid;
 g:=public.consume_housecall_write_approval(step_id,lease);
 if (g->>'used_writes')::integer<>1 or g->>'step_payload_hash'<>s->>'payload_hash' then raise exception 'approval not exact or consumed'; end if;
 begin perform public.consume_housecall_write_approval(step_id,lease);raise exception 'same dispatch authorized twice';exception when others then if sqlerrm<>'conflict' then raise;end if;end;
 begin perform public.finish_housecall_export_step(step_id,lease,'not_sent');raise exception 'uncertain dispatch returned to ready';exception when others then if sqlerrm<>'reconciliation_required' then raise;end if;end;
 begin perform public.finish_housecall_export_step(step_id,lease,'retryable_failure',null,'timeout');raise exception 'timeout blindly retryable';exception when others then if sqlerrm<>'reconciliation_required' then raise;end if;end;
 finished:=public.finish_housecall_export_step(step_id,lease,'uncertain',null,'timeout_after_commit');
 if finished->>'status'<>'reconcile_required' or public.both_housecall_steps_succeeded(receipt) then raise exception 'uncertain marked complete'; end if;
 if not exists(select 1 from public.list_ready_housecall_exports(20) q where q.intent_id=intent) then raise exception 'exhausted approval hid read-only reconciliation';end if;
 begin perform public.manager_recovery_command(receipt,admin_id,intent,'correction',null,'Correction before unknown result reconciled',jsonb_set(snapshot,'{lines,0,qty}','"1"'));raise exception 'uncertain correction accepted';exception when others then if sqlerrm<>'conflict' then raise;end if;end;
 perform public.manager_recovery_command(receipt,manager,intent,'retry',
  (select id from public.export_attempts where export_step_id=step_id and status='permanent_failure' order by created_at desc,id desc limit 1),'Read back uncertain write');
 if (select status from public.housecall_export_steps where id=step_id)<>'reconcile_required' then raise exception 'manager retry blindly requeued uncertain write'; end if;
 if public.claim_housecall_export_step(intent2,'other-receipt') is not null then raise exception 'unresolved destination unblocked'; end if;
 claimed:=public.claim_housecall_export_step(intent,'reconciler');s:=claimed->'step';
 if claimed->>'reconcileOnly'<>'true' or (s->>'id')::uuid<>step_id then raise exception 'uncertain step replayed'; end if;
 begin perform public.consume_housecall_write_approval(step_id,(s->>'lease_token')::uuid);raise exception 'reconciliation issued post';exception when others then if sqlerrm<>'conflict' then raise;end if;end;
 finished:=public.finish_housecall_export_step(step_id,(s->>'lease_token')::uuid,'not_found',null,'zero_matches');
 if finished->>'status'<>'reconcile_required' then raise exception 'absence incorrectly proved safe retry'; end if;
 -- Exact read-back can recover the external success, with job and payload proof.
 claimed:=public.claim_housecall_export_step(intent,'reconciler');s:=claimed->'step';
 begin perform public.finish_housecall_export_step(step_id,(s->>'lease_token')::uuid,'succeeded','ext-a',null,
 jsonb_build_object('verified',true,'housecall_job_id','wrong-job','payload_hash',s->>'payload_hash'));raise exception 'wrong job verified';exception when others then if sqlerrm<>'verification_required' then raise;end if;end;
 finished:=public.finish_housecall_export_step(step_id,(s->>'lease_token')::uuid,'succeeded','ext-a',null,
  jsonb_build_object('verified',true,'housecall_job_id',s->>'housecall_job_id','payload_hash',s->>'payload_hash'));
 perform public.finish_housecall_export_step(step_id,(s->>'lease_token')::uuid,'succeeded','ext-a',null,
  jsonb_build_object('verified',true,'housecall_job_id',s->>'housecall_job_id','payload_hash',s->>'payload_hash'));
 if (select count(*) from public.housecall_links where export_step_id=step_id)<>1 then raise exception 'duplicate link'; end if;
 if (select retention_started_at from public.receipts where id=receipt) is not null then raise exception 'partial export started retention'; end if;
 -- Exhausted approvals cannot authorize the next page, and success cannot retry.
 begin perform public.request_housecall_step_retry(manager,step_id,'retry succeeded');raise exception 'successful step retry accepted';exception when others then if sqlerrm<>'conflict' then raise;end if;end;
 claimed:=public.claim_housecall_export_step(intent,'test-worker');s:=claimed->'step';
 begin perform public.consume_housecall_write_approval((s->>'id')::uuid,(s->>'lease_token')::uuid);raise exception 'exhausted budget accepted';exception when others then if sqlerrm<>'live_write_approval_required' then raise;end if;end;
 perform public.finish_housecall_export_step((s->>'id')::uuid,(s->>'lease_token')::uuid,'not_sent');
 -- A failed second page remains recoverable after page one on the SAME job
 -- succeeded. Legacy receipt/job/NULL-line checks must not collapse these steps.
 g:=public.grant_housecall_write_approval(admin_id,intent,digest,array['ra6-job-a'],now()+interval '1 hour',1,'one additional rejected page test');
 claimed:=public.claim_housecall_export_step(intent,'page-two');s:=claimed->'step';
 if s->>'step'<>'attachment' or s->>'housecall_job_id'<>'ra6-job-a' then raise exception 'multi-page retry fixture is not same job';end if;
 perform public.consume_housecall_write_approval((s->>'id')::uuid,(s->>'lease_token')::uuid);
 begin perform public.finish_housecall_export_step((s->>'id')::uuid,(s->>'lease_token')::uuid,'succeeded','ext-a',null,
  jsonb_build_object('verified',true,'housecall_job_id',s->>'housecall_job_id','payload_hash',s->>'payload_hash'));raise exception 'external identity reused for another page';exception when unique_violation then null;end;
 finished:=public.finish_housecall_export_step((s->>'id')::uuid,(s->>'lease_token')::uuid,'retryable_failure',null,'rate_limited',jsonb_build_object('definitive_rejection',true,'http_status',429));
 approved2:=public.manager_recovery_command(receipt,manager,intent,'retry',
  (select id from public.export_attempts where export_step_id=(s->>'id')::uuid and status='retryable_failure' order by created_at desc,id desc limit 1),'Retry second page after first page succeeded');
 if approved2->>'status'<>'completed' or approved2->>'stepId'<>s->>'id' then raise exception 'same-job successful page blocked failed page recovery';end if;
 if (select status from public.housecall_export_steps where id=step_id)<>'succeeded' then raise exception 'other page recovery changed successful page';end if;
 -- All remaining steps receive separate verification; successful steps skipped.
 g:=public.grant_housecall_write_approval(admin_id,intent,digest,array['ra6-job-a','ra6-job-b'],now()+interval '1 hour',5,'bounded remaining mock test');
 loop
  claimed:=public.claim_housecall_export_step(intent,'test-worker');exit when claimed is null;s:=claimed->'step';
  if (s->>'id')::uuid=step_id then raise exception 'successful step replayed'; end if;
  perform public.consume_housecall_write_approval((s->>'id')::uuid,(s->>'lease_token')::uuid);
  external:='ext-'||(s->>'id');
  perform public.finish_housecall_export_step((s->>'id')::uuid,(s->>'lease_token')::uuid,'succeeded',external,null,
   jsonb_build_object('verified',true,'housecall_job_id',s->>'housecall_job_id','payload_hash',s->>'payload_hash'));
  n:=n+1;if n>10 then raise exception 'claim loop';end if;
 end loop;
 if n<>5 or not public.both_housecall_steps_succeeded(receipt) or (select status from public.receipts where id=receipt)<>'exported'
  or (select retention_started_at from public.receipts where id=receipt) is null then raise exception 'full export aggregation failed'; end if;
 if (select count(*) from public.housecall_links where intent_id=intent)<>6 then raise exception 'page or cost linkage missing'; end if;
 if (select status from public.work_items where receipt_id=receipt and kind='export')<>'succeeded' then raise exception 'work item not complete'; end if;
 if exists(select 1 from public.list_ready_housecall_exports(20) q where q.intent_id=intent) then raise exception 'completed intent starves later ready work';end if;
 -- Manager correction records a proposal and does not mint a new export or grant.
 perform public.manager_recovery_command(receipt,admin_id,intent,'correction',null,'Fix qty',jsonb_set(snapshot,'{lines,0,qty}','"1"'));
 if (select count(*) from public.housecall_intents where receipt_id=receipt)<>1 then raise exception 'correction replayed'; end if;
 -- Missing images retain approval semantics but cannot enter live export.
 approved:=public.manager_review_command('66100000-0000-4000-8000-000000000005',manager,0,null,'approve',snapshot);
 if public.claim_housecall_export_step((approved->>'intentId')::uuid,'test-worker') is not null then raise exception 'image-less export claim'; end if;
 -- A new approval cannot reset the independent eight-dispatch step limit.
 approved:=public.manager_review_command('66100000-0000-4000-8000-000000000003',manager,0,null,'approve',jsonb_set(snapshot,'{lines}',jsonb_build_array(snapshot->'lines'->1)));
 intent2:=(approved->>'intentId')::uuid;
 select payload_hash into digest from public.housecall_intents where id=intent2;
 g:=public.grant_housecall_write_approval(admin_id,intent2,digest,array['ra6-job-b'],now()+interval '1 hour',20,'bounded repeated rejected mock sends');
 for n in 1..8 loop
  claimed:=public.claim_housecall_export_step(intent2,'attempt-cap');s:=claimed->'step';
  if s is null then raise exception 'step ended before attempt cap';end if;
  perform public.consume_housecall_write_approval((s->>'id')::uuid,(s->>'lease_token')::uuid);
  finished:=public.finish_housecall_export_step((s->>'id')::uuid,(s->>'lease_token')::uuid,'retryable_failure',null,'rate_limited',jsonb_build_object('definitive_rejection',true,'http_status',429));
  if (finished->>'dispatch_count')::integer<>n then raise exception 'dispatch count not durable';end if;
 end loop;
 if finished->>'status'<>'permanent_failure' or finished->>'last_error'<>'attempt_limit_reached' then raise exception 'dispatch cap not terminal';end if;
 begin perform public.request_housecall_step_retry(manager,(s->>'id')::uuid,'renewed approval cannot reset cap');raise exception 'dispatch limit retry accepted';exception when others then if sqlerrm<>'attempt_limit_reached' then raise;end if;end;
 -- Revocation immediately blocks the remaining page; no total/retention success.
 perform public.revoke_housecall_write_approval(admin_id,(g->>'id')::uuid,'stop bounded mock run');
 claimed:=public.claim_housecall_export_step(intent2,'revoked');s:=claimed->'step';
 begin perform public.consume_housecall_write_approval((s->>'id')::uuid,(s->>'lease_token')::uuid);raise exception 'revoked approval accepted';exception when others then if sqlerrm<>'live_write_approval_required' then raise;end if;end;
 perform public.finish_housecall_export_step((s->>'id')::uuid,(s->>'lease_token')::uuid,'not_sent');
 if public.both_housecall_steps_succeeded('66100000-0000-4000-8000-000000000003') then raise exception 'attempt limit completed intent';end if;
end;$$;
reset role;
-- Expired lease and stale callback behavior, immutability, role boundaries.
do $$
declare intent uuid; claimed jsonb; s jsonb; claimed2 jsonb; token uuid;
begin
 select intent_id into intent from public.housecall_outbox where receipt_id='66100000-0000-4000-8000-000000000002';
 claimed:=public.claim_housecall_export_step(intent,'lease-expiry');s:=claimed->'step'; token:=(s->>'lease_token')::uuid;
 update public.housecall_export_steps set lease_expires_at=now()-interval '1 second' where id=(s->>'id')::uuid;
 update public.housecall_export_locks set lease_expires_at=now()-interval '1 second' where step_id=(s->>'id')::uuid;
 claimed2:=public.claim_housecall_export_step(intent,'new-owner');
 if claimed2->>'reconcileOnly'<>'true' then raise exception 'stale lease permits blind replay';end if;
 begin perform public.finish_housecall_export_step((s->>'id')::uuid,token,'not_sent');raise exception 'stale worker accepted';exception when others then if sqlerrm<>'conflict' then raise;end if;end;
 begin update public.housecall_export_steps set payload='{}' where id=(s->>'id')::uuid;raise exception 'payload mutation accepted';exception when others then if sqlerrm<>'export_plan_is_immutable' then raise;end if;end;
 if has_table_privilege('authenticated','public.housecall_write_approvals','INSERT') or has_table_privilege('authenticated','public.housecall_export_steps','UPDATE')
  or has_function_privilege('authenticated','public.grant_housecall_write_approval(uuid,uuid,text,text[],timestamptz,integer,text)','EXECUTE')
  or has_function_privilege('anon','public.consume_housecall_write_approval(uuid,uuid)','EXECUTE') then raise exception 'write approval bypass privilege'; end if;
end;$$;
set local role authenticated;
select set_config('request.jwt.claim.sub','66000000-0000-4000-8000-000000000001',true);
do $$begin if exists(select 1 from public.housecall_export_steps) then raise exception 'worker export details leak';end if;end;$$;
select set_config('request.jwt.claim.sub','66000000-0000-4000-8000-000000000002',true);
do $$begin
 if (select count(*) from public.housecall_export_steps)<6 then raise exception 'manager cannot inspect plan';end if;
 if (select count(*) from public.manager_current_export_attempts('66100000-0000-4000-8000-000000000001',(select intent_id from public.housecall_outbox where receipt_id='66100000-0000-4000-8000-000000000001')))<>6 then raise exception 'multi-page results collapsed';end if;
end;$$;
reset role;
update public.receipts set content_deleted_at=now() where id='66100000-0000-4000-8000-000000000001';
do $$begin
 if exists(select 1 from public.housecall_export_steps where receipt_id='66100000-0000-4000-8000-000000000001' and payload is not null)
  or exists(select 1 from public.housecall_intents where receipt_id='66100000-0000-4000-8000-000000000001' and (approved_images<>'[]' or approved_reference<>'')) then raise exception 'purged export content remains';end if;
end;$$;
rollback;
