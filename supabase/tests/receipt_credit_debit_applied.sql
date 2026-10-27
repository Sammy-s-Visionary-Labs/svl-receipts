begin;
insert into auth.users(id,aud,role,email,raw_app_meta_data) values
 ('67300000-0000-4000-8000-000000000001','authenticated','authenticated','credit-fixture-worker@example.invalid','{"svl_access_approved":true}'),
 ('67300000-0000-4000-8000-000000000002','authenticated','authenticated','credit-fixture-manager@example.invalid','{"svl_access_approved":true}');
update public.profiles set role='manager' where id='67300000-0000-4000-8000-000000000002';
insert into public.receipt_categories(id,label) values('credit-fixture-materials','Synthetic credit fixtures');
insert into public.manager_job_catalog(id,label,customer_id,source,synced_at) values('credit-fixture-job','Synthetic credit test','credit-fixture-customer','housecall',now());
insert into public.receipts(id,owner_user_id,status,submitted_at)
 select ('67400000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'67300000-0000-4000-8000-000000000001','needs_review',now() from generate_series(1,3)n;
insert into public.receipt_pages(receipt_id,page_index,storage_key,content_type,checksum,byte_size,confirmed_at)
 select r.id,0,'SYNTHETIC-credit/'||r.id||'.jpg','image/jpeg',repeat('a',64),100,now() from public.receipts r where r.id::text like '67400000%';
set local role service_role;
do $$
declare manager_id uuid:='67300000-0000-4000-8000-000000000002'; debit_id uuid:='67400000-0000-4000-8000-000000000001'; credit_id uuid:='67400000-0000-4000-8000-000000000002'; result jsonb; debit_intent uuid; credit_intent uuid; debit_keys text[]; credit_keys text[];
 draft jsonb:='{"receiptType":"debit","vendor":"SYNTHETIC CREDIT FIXTURE","purchaseDate":"2026-10-27","invoiceNumber":"SYN-CREDIT-42","ticketNumber":"","category":"credit-fixture-materials","referenceTotal":"3.77","managerNotes":"Rollback-only fixtures","lines":[{"description":"Synthetic returned pipe","qty":"1.5","uom":"ea","unitCost":"2.51","jobId":"credit-fixture-job"}]}';
begin
 result:=public.manager_review_with_export(debit_id,manager_id,0,null,'approve',draft);debit_intent:=(result->>'intentId')::uuid;
 perform public.manager_review_command(credit_id,manager_id,0,null,'save_draft',jsonb_set(draft,'{receiptType}','"credit"'));
 perform public.refresh_receipt_duplicate_candidates(credit_id,jsonb_set(draft,'{receiptType}','"credit"'));
 if exists(select 1 from public.duplicate_candidates where receipt_id=credit_id and candidate_receipt_id=debit_id) then raise exception 'return mistaken for original debit';end if;
 result:=public.manager_review_with_export(credit_id,manager_id,1,null,'approve',jsonb_set(draft,'{receiptType}','"credit"'));credit_intent:=(result->>'intentId')::uuid;
 if (select sum(qty*unit_cost_cents) from public.receipt_lines where receipt_id=credit_id)<>-376.5 then raise exception 'credit sign applied incorrectly';end if;
 if not exists(select 1 from public.housecall_export_steps where intent_id=credit_intent and step='job_cost' and payload->>'receipt_type'='credit' and payload->>'material_format_version'='3' and (payload#>>'{line,unit_cost_cents}')::integer=-251 and (payload#>>'{line,extended_cost_cents}')::integer=-377) then raise exception 'negative frozen credit missing';end if;
 if not exists(select 1 from public.housecall_export_steps where intent_id=debit_intent and step='job_cost' and (payload#>>'{line,unit_cost_cents}')::integer=251 and (payload#>>'{line,extended_cost_cents}')::integer=377) then raise exception 'debit changed';end if;
 if (select approved_reference from public.housecall_intents where id=credit_intent) not like 'CREDIT %' then raise exception 'credit reference missing';end if;
 select array_agg(k) into debit_keys from public.receipt_purchase_keys(draft,null)k;
 select array_agg(k) into credit_keys from public.receipt_purchase_keys(jsonb_set(draft,'{receiptType}','"credit"'),null)k;
 if debit_keys && credit_keys then raise exception 'credit retention fingerprint collides with debit';end if;
 begin
  perform public.manager_review_with_export('67400000-0000-4000-8000-000000000003',manager_id,0,null,'approve',jsonb_set(draft,'{receiptType}','""'));
  raise exception 'unknown type approved';
 exception when others then if sqlerrm<>'invalid_request_receipt_type' then raise;end if;end;
 begin
  perform public.manager_review_command(credit_id,manager_id,2,null,'approve',jsonb_set(draft,'{receiptType}','"credit"'));
  raise exception 'credit replay accepted';
 exception when others then if sqlerrm<>'conflict' then raise;end if;end;
end;$$;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','67300000-0000-4000-8000-000000000002',true);
do $$
begin
 if not exists(select 1 from public.manager_review_queue(p_tab=>'history')q where q->>'id'='67400000-0000-4000-8000-000000000002' and q->>'receiptType'='credit') then raise exception 'queue credit type missing';end if;
 if has_function_privilege('authenticated','public.manager_review_command(uuid,uuid,integer,uuid,text,jsonb,text,uuid)','execute') then raise exception 'browser may approve directly';end if;
end;$$;
reset role;
rollback;
