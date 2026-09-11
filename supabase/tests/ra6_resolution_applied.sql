-- Local rollback-only recovery and scope tests; no provider access.
begin;
insert into auth.users(id,aud,role,email) values
 ('64900000-0000-4000-8000-000000000001','authenticated','authenticated','ra6resolution-worker@example.invalid'),
 ('64900000-0000-4000-8000-000000000002','authenticated','authenticated','ra6resolution-admin@example.invalid');
update public.profiles set role='admin' where id='64900000-0000-4000-8000-000000000002';
insert into public.receipt_categories(id,label) values('ra6resolution','Synthetic resolution');
insert into public.manager_job_catalog(id,label) values('ra6resolution-job','Synthetic resolution');
insert into public.receipts(id,owner_user_id,status,submitted_at) values('64910000-0000-4000-8000-000000000001','64900000-0000-4000-8000-000000000001','needs_review',now());
insert into public.receipt_pages(receipt_id,page_index,storage_key,content_type,checksum,byte_size,confirmed_at) values('64910000-0000-4000-8000-000000000001',0,'ra6resolution/page.png','image/png',repeat('a',64),100,now());
set local role service_role;
do $$
declare admin_id uuid:='64900000-0000-4000-8000-000000000002'; worker_id uuid:='64900000-0000-4000-8000-000000000001'; receipt uuid:='64910000-0000-4000-8000-000000000001';
 snapshot jsonb:='{"vendor":"SYNTHETIC","purchaseDate":"2026-09-10","invoiceNumber":"RA6-resolution","ticketNumber":"","category":"ra6resolution","referenceTotal":"1.01","managerNotes":"test","lines":[{"description":"Synthetic material","qty":"1.005","uom":"ea","unitCost":"1.00","jobId":"ra6resolution-job"}]}';
 intent uuid; digest text; claimed jsonb; s jsonb; evidence jsonb; result jsonb; original jsonb; token uuid; started timestamptz;
begin
 result:=public.manager_review_command(receipt,admin_id,0,null,'approve',snapshot);intent:=(result->>'intentId')::uuid;
 select payload_hash,to_jsonb(i) into digest,original from public.housecall_intents i where id=intent;
 perform public.grant_housecall_write_approval(admin_id,intent,digest,array['ra6resolution-job'],clock_timestamp()+interval '1 hour',2,'synthetic SQL');
 -- Health failures preserve the last successful read-only probe and sanitize codes.
 result:=public.housecall_health_status(true,null);started:=(result->>'lastSuccessfulCheckAt')::timestamptz;
 if started is null then raise exception 'successful health timestamp missing';end if;
 result:=public.housecall_health_status(false,'authentication');
 if (result->>'lastSuccessfulCheckAt')::timestamptz is distinct from started or result->>'lastError'<>'authentication' then raise exception 'health history lost';end if;
 begin perform public.housecall_health_status(false,'raw secret details');raise exception 'raw error stored';exception when others then if sqlerrm<>'invalid_request' then raise;end if;end;
 -- First page succeeds; next material remains uncertain after one dispatch.
 claimed:=public.claim_housecall_export_step(intent,'resolution-test');s:=claimed->'step';
 perform public.consume_housecall_write_approval((s->>'id')::uuid,(s->>'lease_token')::uuid);
 perform public.finish_housecall_export_step((s->>'id')::uuid,(s->>'lease_token')::uuid,'succeeded','synthetic-attachment',null,jsonb_build_object('verified',true,'housecall_job_id','ra6resolution-job','payload_hash',s->>'payload_hash'));
 claimed:=public.claim_housecall_export_step(intent,'resolution-test');s:=claimed->'step';
 perform public.consume_housecall_write_approval((s->>'id')::uuid,(s->>'lease_token')::uuid);
 perform public.finish_housecall_export_step((s->>'id')::uuid,(s->>'lease_token')::uuid,'uncertain',null,'precision_mismatch');
 select jsonb_agg(jsonb_build_object('step_id',id,'payload_hash',payload_hash,'updated_at',updated_at,'job_id',housecall_job_id,'observed_at',clock_timestamp(),'outcome','present','external_id',case when step='attachment' then 'synthetic-attachment' else 'synthetic-material' end,'observed',jsonb_build_object('quantity',1.01)) order by step) into evidence from public.housecall_export_steps where intent_id=intent;
 begin perform public.close_housecall_export_for_manual_handling(worker_id,receipt,intent,digest,'test',evidence);raise exception 'worker closed export';exception when others then if sqlerrm<>'forbidden' then raise;end if;end;
 begin perform public.close_housecall_export_for_manual_handling(admin_id,receipt,intent,digest,'test',jsonb_set(evidence,'{1,outcome}','"absent"'));raise exception 'uncertain absence accepted';exception when others then if sqlerrm<>'reconciliation_required' then raise;end if;end;
 begin perform public.close_housecall_export_for_manual_handling(admin_id,receipt,intent,digest,'test',jsonb_set(evidence,'{1,updated_at}','"2000-01-01T00:00:00Z"'));raise exception 'stale evidence accepted';exception when others then if sqlerrm<>'conflict' then raise;end if;end;
 begin perform public.close_housecall_export_for_manual_handling(admin_id,receipt,intent,digest,'test',jsonb_set(evidence,'{1,observed_at}','"2000-01-01T00:00:00Z"'));raise exception 'old readback accepted';exception when others then if sqlerrm<>'conflict' then raise;end if;end;
 if exists(select 1 from public.housecall_manual_resolutions where receipt_id=receipt) then raise exception 'rejected closure partially committed';end if;
 result:=public.close_housecall_export_for_manual_handling(admin_id,receipt,intent,digest,'Provider rounded; manually handle remaining test costs',evidence);
 if result->>'closed'<>'true' or result->>'exported'<>'false' then raise exception 'incorrect closure result';end if;
 if (select to_jsonb(i) from public.housecall_intents i where id=intent) is distinct from original then raise exception 'frozen intent changed';end if;
 if (select status from public.receipts where id=receipt)<>'partial_success' or public.both_housecall_steps_succeeded(receipt) then raise exception 'manual closure claimed export success';end if;
 if (select retention_started_at from public.receipts where id=receipt) is not null then raise exception 'manual closure started retention';end if;
 if exists(select 1 from public.housecall_write_approvals where intent_id=intent and revoked_at is null) then raise exception 'manual closure retained grant';end if;
 if public.claim_housecall_export_step(intent,'must-not-retry') is not null then raise exception 'cancelled export retried';end if;
 begin perform public.close_housecall_export_for_manual_handling(admin_id,receipt,intent,digest,'duplicate',evidence);raise exception 'duplicate closure accepted';exception when others then if sqlerrm<>'conflict' then raise;end if;end;
 -- A scoped full sync invalidates missing jobs only inside that scope.
 insert into public.manager_job_catalog(id,label,source,customer_id,active,unavailable) values('ra6resolution-outside','Outside scope','housecall','customer_other',true,false),('ra6resolution-missing','Missing in scope','housecall','customer_test',true,false);
 token:=(public.claim_housecall_job_sync(180)->>'lease_token')::uuid;started:=clock_timestamp();
 perform public.finish_housecall_job_sync(token,started,'[]',true,array[]::text[],array['customer_test']);
 if not exists(select 1 from public.manager_job_catalog where id='ra6resolution-outside' and active and not unavailable) then raise exception 'scoped scan altered outside job';end if;
 if not exists(select 1 from public.manager_job_catalog where id='ra6resolution-missing' and not active and unavailable) then raise exception 'scoped scan missed absent job';end if;
 if (select customer_scope from public.housecall_sync_state where id) is distinct from array['customer_test'] then raise exception 'sync scope not recorded';end if;
end;$$;
reset role;
do $$begin
 if exists(select 1 from public.housecall_export_locks where step_id in(select id from public.housecall_export_steps where receipt_id='64910000-0000-4000-8000-000000000001')) then raise exception 'manual closure retained lock';end if;
end;$$;
set local role authenticated;
select set_config('request.jwt.claim.sub','64900000-0000-4000-8000-000000000001',true);
do $$begin
 if exists(select 1 from public.housecall_manual_resolutions where receipt_id='64910000-0000-4000-8000-000000000001') then raise exception 'worker read resolution evidence';end if;
 if has_table_privilege('authenticated','public.housecall_health_state','SELECT,INSERT,UPDATE,DELETE') or has_function_privilege('authenticated','public.housecall_health_status(boolean,text)','EXECUTE') then raise exception 'browser health state access';end if;
 if has_function_privilege('authenticated','public.close_housecall_export_for_manual_handling(uuid,uuid,uuid,text,text,jsonb)','EXECUTE') then raise exception 'browser can spoof resolution actor';end if;
end;$$;
select set_config('request.jwt.claim.sub','64900000-0000-4000-8000-000000000002',true);
do $$begin
 if (select count(*) from public.housecall_manual_resolutions where receipt_id='64910000-0000-4000-8000-000000000001')<>1 then raise exception 'admin cannot see audit resolution';end if;
end;$$;
reset role;
rollback;
