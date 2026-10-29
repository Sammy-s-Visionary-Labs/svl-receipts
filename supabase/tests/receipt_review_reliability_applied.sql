begin;
-- Synthetic fixtures. Every change, including the function under test, is rolled back by the caller.
insert into auth.users(id,aud,role,email,raw_app_meta_data) values
 ('67100000-0000-4000-8000-000000000001','authenticated','authenticated','reliability-worker@example.invalid','{"svl_access_approved":true}'::jsonb),
 ('67100000-0000-4000-8000-000000000002','authenticated','authenticated','reliability-manager@example.invalid','{"svl_access_approved":true}'::jsonb);
update public.profiles set role='manager' where id='67100000-0000-4000-8000-000000000002';
insert into public.receipt_categories(id,label) values('reliability-materials','Synthetic reliability materials');
insert into public.manager_job_catalog(id,label,customer_id,source,synced_at) values
 ('reliability-job','Synthetic reliability job','reliability-customer','housecall',now());
insert into public.receipts(id,owner_user_id,status,submitted_at)
 select ('67200000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 '67100000-0000-4000-8000-000000000001','needs_review',now() from generate_series(1,2)n;
insert into public.receipt_pages(receipt_id,page_index,storage_key,content_type,checksum,byte_size,confirmed_at)
 select r.id,0,'synthetic-reliability/'||r.id||'.jpg','image/jpeg',repeat('a',64),100,now()
 from public.receipts r where r.id in ('67200000-0000-4000-8000-000000000001','67200000-0000-4000-8000-000000000002');
set local role service_role;
do $$
declare manager_id uuid:='67100000-0000-4000-8000-000000000002';
 receipt uuid:='67200000-0000-4000-8000-000000000001'; result jsonb; intent uuid;
 snapshot jsonb:='{"vendor":"SYNTHETIC RELIABILITY","purchaseDate":"2026-10-27","invoiceNumber":"SYN-RELIABILITY","ticketNumber":"","category":"reliability-materials","referenceTotal":"10","managerNotes":"rollback-only fixture","lines":[{"description":"Ticket reference excluded by manager","qty":"0","uom":"","unitCost":"0","jobId":""},{"description":"Free connector","qty":"2","uom":"ea","unitCost":"0.00","jobId":"reliability-job"},{"description":"Paid pipe","qty":"1.5","uom":"ft","unitCost":"2.50","jobId":"reliability-job"}]}';
begin
 result:=public.manager_review_command(receipt,manager_id,0,null,'save_draft',snapshot);
 if (select v.snapshot->'lines'->0->>'qty' from public.reviews v where receipt_id=receipt order by version desc limit 1)<>'0'
 then raise exception 'zero draft was not preserved'; end if;
 begin
  perform public.manager_review_with_export('67200000-0000-4000-8000-000000000002',manager_id,0,null,'approve',jsonb_set(snapshot,'{lines}',jsonb_build_array(snapshot->'lines'->0)));
  raise exception 'all-zero receipt approved';
 exception when others then if sqlerrm<>'invalid_request_material_required' then raise;end if;end;
 begin
  perform public.manager_review_command(receipt,manager_id,1,null,'save_draft',jsonb_set(snapshot,'{lines,0,qty}','"-1"'));
  raise exception 'negative quantity accepted';
 exception when others then if sqlerrm<>'invalid_request_number' then raise;end if;end;
 result:=public.manager_review_with_export(receipt,manager_id,1,null,'approve',snapshot);
 intent:=(result->>'intentId')::uuid;
 if result->>'exportAuthorized'<>'true' then raise exception 'manager approval missing';end if;
 if (select count(*) from public.receipt_lines where receipt_id=receipt)<>2 then raise exception 'zero receipt line was exported';end if;
 if (select count(*) from public.housecall_export_steps where intent_id=intent and step='job_cost')<>2 then raise exception 'wrong material step count';end if;
 if exists(select 1 from public.housecall_export_steps where intent_id=intent and step='job_cost' and (payload#>>'{line,qty}')::numeric<=0) then raise exception 'zero provider quantity';end if;
 if not exists(select 1 from public.housecall_export_steps where intent_id=intent and step='job_cost' and payload#>>'{line,description}'='Free connector' and (payload#>>'{line,unit_cost_cents}')::numeric=0) then raise exception 'zero unit cost lost';end if;
 if (select attachment_job_ids from public.housecall_intents where id=intent)<>'["reliability-job"]'::jsonb then raise exception 'excluded destination included';end if;
 if (select jsonb_array_length(v.snapshot->'lines') from public.reviews v where receipt_id=receipt and decision='approve')<>3 then raise exception 'review evidence lost';end if;
end;$$;
reset role;
rollback;
