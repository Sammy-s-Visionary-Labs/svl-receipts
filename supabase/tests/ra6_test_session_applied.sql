begin;
insert into auth.users(id,aud,role,email) values
 ('79100000-0000-4000-8000-000000000001','authenticated','authenticated','ra6-flow-worker@example.invalid'),
 ('79100000-0000-4000-8000-000000000002','authenticated','authenticated','ra6-flow-manager@example.invalid'),
 ('79100000-0000-4000-8000-000000000003','authenticated','authenticated','ra6-flow-admin@example.invalid'),
 ('79100000-0000-4000-8000-000000000004','authenticated','authenticated','ra6-flow-other@example.invalid');
update public.profiles set role='manager' where id='79100000-0000-4000-8000-000000000002';
update public.profiles set role='admin' where id='79100000-0000-4000-8000-000000000003';
insert into public.receipt_categories(id,label) values('ra6-flow-materials','Flow materials');
insert into public.manager_job_catalog(id,label,customer_id,source,synced_at)
 values('ra6-flow-job','Flow test job','ra6-flow-customer','housecall',now()),
 ('ra6-outside-job','Outside job','outside-customer','housecall',now());
set local role service_role;
select set_config('svl.integration_session_id',public.create_housecall_test_session(
 '79100000-0000-4000-8000-000000000003',array['79100000-0000-4000-8000-000000000001']::uuid[],
 array['79100000-0000-4000-8000-000000000002']::uuid[],'{"ra6-flow-job":"ra6-flow-customer"}',
 now()+interval '1 hour',1,3,2100,2100,'Scoped rollback-only integration test')::text,true);
reset role;
-- Simulate an elapsed authorization without weakening the immutable policy.
insert into public.housecall_test_sessions(id,authorized_by,owner_ids,reviewer_ids,job_bindings,
 reason,created_at,expires_at,max_receipts,max_writes,max_total_cents,max_receipt_cents)
 select '79300000-0000-4000-8000-000000000001',authorized_by,owner_ids,reviewer_ids,job_bindings,
 'Expired rollback-only fixture',now()-interval '2 hours',now()-interval '1 hour',
 max_receipts,max_writes,max_total_cents,max_receipt_cents
 from public.housecall_test_sessions where id=current_setting('svl.integration_session_id')::uuid;
insert into public.receipts(id,owner_user_id,status,submitted_at,created_at)
 select ('79200000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 case when n=6 then '79100000-0000-4000-8000-000000000004'::uuid else '79100000-0000-4000-8000-000000000001'::uuid end,
 'needs_review',clock_timestamp(),case when n=5 then now()-interval '1 day' else clock_timestamp() end
 from generate_series(1,8)n;
insert into public.receipt_pages(receipt_id,page_index,storage_key,content_type,checksum,byte_size,confirmed_at)
 select r.id,p,'ra6-flow/'||r.id||'/'||p||'.jpg','image/jpeg',repeat('a',64),100,now()
 from public.receipts r cross join generate_series(0,1)p where r.id::text like '79200000%';
set local role service_role;
do $$
declare session_id uuid:=current_setting('svl.integration_session_id')::uuid;
 manager_id uuid:='79100000-0000-4000-8000-000000000002'; admin_id uuid:='79100000-0000-4000-8000-000000000003';
 snapshot jsonb:='{"vendor":"SYNTHETIC FLOW","purchaseDate":"2026-09-10","invoiceNumber":"FLOW-1","ticketNumber":"","category":"ra6-flow-materials","referenceTotal":"22.63","managerNotes":"test only","lines":[{"description":"Limestone","qty":"0.5","uom":"ton","unitCost":"42.00","jobId":"ra6-flow-job"}]}';
 result jsonb; claimed_step jsonb; grant_result jsonb; test_intent uuid; n integer;
begin
 begin perform public.manager_review_with_test_export('79300000-0000-4000-8000-000000000001','79200000-0000-4000-8000-000000000008',manager_id,0,null,'approve',snapshot);
  raise exception 'expired session approved';exception when others then if sqlerrm<>'test_export_scope' then raise;end if;end;
 begin update public.housecall_test_sessions set expires_at=expires_at+interval '1 hour' where id=session_id;
  raise exception 'authorization extended';exception when others then if sqlerrm<>'immutable_test_authorization' then raise;end if;end;
 begin perform public.manager_review_with_test_export(session_id,'79200000-0000-4000-8000-000000000003',manager_id,0,null,'approve',jsonb_set(snapshot,'{lines,0,jobId}','"ra6-outside-job"'));
  raise exception 'outside job exported';exception when others then if sqlerrm<>'test_export_scope' then raise;end if;end;
 begin perform public.manager_review_with_test_export(session_id,'79200000-0000-4000-8000-000000000004',manager_id,0,null,'approve',jsonb_set(snapshot,'{lines,0,qty}','"1.005"'));
  raise exception 'quantity silently rounded';exception when others then if sqlerrm<>'unsupported_quantity_precision' then raise;end if;end;
 foreach n in array array[5,6] loop
  begin perform public.manager_review_with_test_export(session_id,('79200000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,manager_id,0,null,'approve',snapshot);
   raise exception 'outside owner or historical receipt exported';exception when others then if sqlerrm<>'test_export_scope' then raise;end if;end;
 end loop;
 begin perform public.manager_review_with_test_export(session_id,'79200000-0000-4000-8000-000000000007',admin_id,0,null,'approve',snapshot);
  raise exception 'unbound reviewer exported';exception when others then if sqlerrm<>'test_export_scope' then raise;end if;end;
 if exists(select 1 from public.housecall_intents where receipt_id::text like '79200000%')
  or exists(select 1 from public.reviews where receipt_id::text like '79200000%')
  or (select reserved_writes from public.housecall_test_sessions where id=session_id)<>0 then raise exception 'failed authorization did not roll back review';end if;
 result:=public.manager_review_with_test_export(session_id,'79200000-0000-4000-8000-000000000001',manager_id,0,null,'approve',snapshot);
 test_intent:=(result->>'intentId')::uuid;
 if result->>'exportAuthorized'<>'true' or (select count(*) from public.housecall_write_approvals where test_session_id=session_id)<>1
  or (select max_writes from public.housecall_write_approvals where intent_id=test_intent)<>3 then raise exception 'exact approval not atomic';end if;
 begin perform public.manager_review_with_test_export(session_id,'79200000-0000-4000-8000-000000000002',manager_id,0,null,'approve',snapshot);
  raise exception 'budget overrun';exception when others then if sqlerrm<>'test_export_budget' then raise;end if;end;
 begin perform public.manager_review_with_test_export(session_id,'79200000-0000-4000-8000-000000000001',manager_id,0,null,'approve',snapshot);
  raise exception 'approval replay accepted';exception when others then if sqlerrm not like '%conflict%' and sqlerrm not like '%approved%' then raise;end if;end;
 if (select reserved_receipts from public.housecall_test_sessions where id=session_id)<>1
  or (select reserved_cents from public.housecall_test_sessions where id=session_id)<>2100 then raise exception 'replay increased budget';end if;
 claimed_step:=public.claim_housecall_export_step(test_intent,'session-test')->'step';
 grant_result:=public.consume_housecall_write_approval((claimed_step->>'id')::uuid,(claimed_step->>'lease_token')::uuid);
 if grant_result->>'test_session_id' is distinct from session_id::text then raise exception 'session missing at dispatch';end if;
 perform public.finish_housecall_export_step((claimed_step->>'id')::uuid,(claimed_step->>'lease_token')::uuid,'succeeded','flow-page-one',null,
  jsonb_build_object('verified',true,'housecall_job_id',claimed_step->>'housecall_job_id','payload_hash',claimed_step->>'payload_hash'));
 perform public.revoke_housecall_test_session(admin_id,session_id,'Stop test session');
 claimed_step:=public.claim_housecall_export_step(test_intent,'revoked-session')->'step';
 begin perform public.consume_housecall_write_approval((claimed_step->>'id')::uuid,(claimed_step->>'lease_token')::uuid);
  raise exception 'revoked session dispatched';exception when others then if sqlerrm<>'live_write_approval_required' then raise;end if;end;
 if (select used_writes from public.housecall_write_approvals where intent_id=test_intent)<>1 then raise exception 'revoked dispatch consumed budget';end if;
 if (select dispatch_count from public.housecall_export_steps where id=(claimed_step->>'id')::uuid)<>0 then raise exception 'revoked dispatch changed durable state';end if;
end;$$;
reset role;
do $$
begin
 if has_table_privilege('authenticated','public.housecall_test_sessions','SELECT')
  or has_function_privilege('authenticated','public.manager_review_with_test_export(uuid,uuid,uuid,integer,uuid,text,jsonb,text,uuid)','EXECUTE')
  or has_function_privilege('anon','public.create_housecall_test_session(uuid,uuid[],uuid[],jsonb,timestamptz,integer,integer,integer,integer,text)','EXECUTE')
  then raise exception 'public authorization surface exposed';end if;
end;$$;
rollback;
