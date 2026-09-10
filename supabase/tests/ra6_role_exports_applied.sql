begin;
insert into auth.users(id,aud,role,email) values
 ('89100000-0000-4000-8000-000000000001','authenticated','authenticated','role-worker@example.invalid'),
 ('89100000-0000-4000-8000-000000000002','authenticated','authenticated','role-manager@example.invalid'),
 ('89100000-0000-4000-8000-000000000003','authenticated','authenticated','role-admin@example.invalid');
update public.profiles set role='manager' where id='89100000-0000-4000-8000-000000000002';
update public.profiles set role='admin' where id='89100000-0000-4000-8000-000000000003';
insert into public.receipt_categories(id,label) values('role-materials','Role materials');
insert into public.manager_job_catalog(id,label,customer_id,source,synced_at) values
 ('role-arbitrary-job','Any business job','role-customer','housecall',now()),
 ('role-stale-job','Stale job','role-customer','housecall',now()-interval '27 hours'),
 ('role-demo-job','Demo job',null,'manual',now());
insert into public.receipts(id,owner_user_id,status,submitted_at,created_at)
 select ('89200000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 '89100000-0000-4000-8000-000000000001','needs_review',now(),now()-interval '90 days'
 from generate_series(1,6)n;
insert into public.receipt_pages(receipt_id,page_index,storage_key,content_type,checksum,byte_size,confirmed_at)
 select r.id,0,'role-flow/'||r.id||'.jpg','image/jpeg',repeat('a',64),100,now()
 from public.receipts r where r.id::text like '89200000%';
set local role service_role;
do $$
declare worker_id uuid:='89100000-0000-4000-8000-000000000001'; manager_id uuid:='89100000-0000-4000-8000-000000000002';
 target_receipt uuid:='89200000-0000-4000-8000-000000000001'; result jsonb; claim jsonb; permit jsonb; approval_count integer;
 snapshot jsonb:='{"vendor":"ROLE FLOW","purchaseDate":"2026-09-10","invoiceNumber":"ROLE-1","ticketNumber":"","category":"role-materials","referenceTotal":"2500","managerNotes":"rollback only","lines":[{"description":"Material","qty":"25","uom":"ea","unitCost":"100","jobId":"role-arbitrary-job"}]}';
begin
 begin perform public.manager_review_with_export(target_receipt,worker_id,0,null,'approve',snapshot);
  raise exception 'worker approved'; exception when others then if sqlerrm<>'forbidden' then raise;end if;end;
 update public.profiles set disabled=true where id=manager_id;
 begin perform public.manager_review_with_export(target_receipt,manager_id,0,null,'approve',snapshot);
  raise exception 'disabled manager approved'; exception when others then if sqlerrm<>'unauthenticated' then raise;end if;end;
 update public.profiles set disabled=false where id=manager_id;
 begin perform public.manager_review_with_export(target_receipt,manager_id,0,null,'approve',jsonb_set(snapshot,'{lines,0,qty}','"1.005"'));
  raise exception 'quantity rounded'; exception when others then if sqlerrm<>'unsupported_quantity_precision' then raise;end if;end;
 begin perform public.manager_review_with_export(target_receipt,manager_id,0,null,'approve',jsonb_set(snapshot,'{lines,0,jobId}','"role-stale-job"'));
  raise exception 'stale approved'; exception when others then if sqlerrm<>'invalid_request_job_unavailable' then raise;end if;end;
 begin perform public.manager_review_with_export(target_receipt,manager_id,0,null,'approve',jsonb_set(snapshot,'{lines,0,jobId}','"role-demo-job"'));
  raise exception 'demo approved'; exception when others then if sqlerrm<>'invalid_request_job_unavailable' then raise;end if;end;
 if exists(select 1 from public.reviews r where r.receipt_id=target_receipt) then raise exception 'failed approval retained draft';end if;
 result:=public.manager_review_with_export(target_receipt,manager_id,0,null,'approve',snapshot);
 if result->>'exportAuthorized'<>'true' then raise exception 'manager not authorized';end if;
 select count(*) into approval_count from public.housecall_write_approvals a where a.intent_id=(result->>'intentId')::uuid
  and a.approved_by=manager_id and a.authorization_kind='manager_review' and a.test_session_id is null
  and a.expires_at='infinity' and a.job_bindings='{"role-arbitrary-job":"role-customer"}' and a.job_ids=array['role-arbitrary-job'];
 if approval_count<>1 then raise exception 'wrong grant';end if;
 begin
  insert into public.housecall_write_approvals(intent_id,payload_hash,job_ids,approved_by,reason,expires_at,max_writes)
  values((result->>'intentId')::uuid,repeat('b',64),array['role-arbitrary-job'],manager_id,'forged direct operator grant',now()+interval '1 hour',1);
  raise exception 'service bypassed manager grant validation';
 exception when others then if sqlerrm<>'invalid_export_approval' then raise;end if;end;
 begin
  insert into public.housecall_write_approvals(intent_id,payload_hash,job_ids,approved_by,reason,expires_at,max_writes,authorization_kind,job_bindings)
  values((result->>'intentId')::uuid,repeat('b',64),array['role-arbitrary-job'],manager_id,'forged payload','infinity',16,'manager_review','{"role-arbitrary-job":"other"}');
  raise exception 'service forged manager payload';
 exception when others then if sqlerrm<>'invalid_export_approval' then raise;end if;end;
 begin perform public.manager_review_with_export(target_receipt,manager_id,0,null,'approve',snapshot);
  raise exception 'replay approved'; exception when others then if sqlerrm not like '%conflict%' then raise;end if;end;
 claim:=public.claim_housecall_export_step((result->>'intentId')::uuid,'role-test')->'step';
 update public.profiles set role='worker' where id=manager_id;
 begin perform public.consume_housecall_write_approval((claim->>'id')::uuid,(claim->>'lease_token')::uuid);
  raise exception 'demoted manager dispatched'; exception when others then if sqlerrm<>'forbidden' then raise;end if;end;
 update public.profiles set role='manager',disabled=true where id=manager_id;
 begin perform public.consume_housecall_write_approval((claim->>'id')::uuid,(claim->>'lease_token')::uuid);
  raise exception 'disabled manager dispatched'; exception when others then if sqlerrm<>'unauthenticated' then raise;end if;end;
 if exists(select 1 from public.housecall_write_approvals a where a.intent_id=(result->>'intentId')::uuid and a.used_writes<>0)
  then raise exception 'denied dispatch consumed budget';end if;
 update public.profiles set disabled=false where id=manager_id;
 permit:=public.consume_housecall_write_approval((claim->>'id')::uuid,(claim->>'lease_token')::uuid);
 if (permit->>'dispatch_expires_at')::timestamptz>(permit->>'dispatch_authorized_at')::timestamptz+interval '2 minutes'
  or permit->>'dispatch_authorized_at' is null then raise exception 'unbounded dispatch permit';end if;
 perform public.manager_review_with_export('89200000-0000-4000-8000-000000000002','89100000-0000-4000-8000-000000000003',0,null,'approve',snapshot);
end;$$;
reset role;
do $$begin
 if has_function_privilege('authenticated','public.manager_review_with_export(uuid,uuid,integer,uuid,text,jsonb,text,uuid)','execute')
  or has_function_privilege('anon','public.manager_review_with_export(uuid,uuid,integer,uuid,text,jsonb,text,uuid)','execute')
  or has_table_privilege('authenticated','public.housecall_write_approvals','insert') then raise exception 'browser can grant exports';end if;
end;$$;
rollback;
