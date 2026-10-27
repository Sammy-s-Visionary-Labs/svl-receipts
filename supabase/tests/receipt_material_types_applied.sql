begin;
insert into auth.users(id,aud,role,email,raw_app_meta_data) values
 ('68300000-0000-4000-8000-000000000001','authenticated','authenticated','material-admin@example.invalid','{"svl_access_approved":true}');
update public.profiles set role='admin' where id='68300000-0000-4000-8000-000000000001';
insert into public.receipt_categories(id,label) values('material-types-fixture','Synthetic material types');
insert into public.manager_job_catalog(id,label,customer_id,source,synced_at) values('material-types-job','Synthetic material types','material-types-customer','housecall',now());
insert into public.receipts(id,owner_user_id,status,submitted_at) values
 ('68400000-0000-4000-8000-000000000001','68300000-0000-4000-8000-000000000001','needs_review','1900-01-01'),
 ('68400000-0000-4000-8000-000000000002','68300000-0000-4000-8000-000000000001','needs_review','1900-01-01');
insert into public.receipt_pages(receipt_id,page_index,storage_key,content_type,checksum,byte_size,confirmed_at)
 select id,0,'SYNTHETIC-material-types/'||id||'.jpg','image/jpeg',repeat('b',64),100,now() from public.receipts where id::text like '68400000%';
set local role service_role;
do $$
declare actor uuid:='68300000-0000-4000-8000-000000000001'; rec uuid:='68400000-0000-4000-8000-000000000001'; result jsonb; intent uuid; prior_hash text; item jsonb;
 draft jsonb:='{"receiptType":"debit","vendor":"SYNTHETIC MIXED","purchaseDate":"2026-10-27","invoiceNumber":"SYN-MIXED-42","ticketNumber":"","category":"material-types-fixture","referenceTotal":"7.50","managerNotes":"Rollback only","lines":[{"description":"New pipe","qty":"2","uom":"ea","unitCost":"5.00","jobId":"material-types-job"},{"receiptType":"credit","description":"Returned connector","qty":"1","uom":"ea","unitCost":"2.50","jobId":"material-types-job"}]}';
begin
 result:=public.manager_review_with_export(rec,actor,0,null,'approve',draft);intent:=(result->>'intentId')::uuid;
 if (select sum(round(qty*unit_cost_cents)) from public.receipt_lines where receipt_id=rec)<>750 then raise exception 'mixed total wrong';end if;
 if not exists(select 1 from public.housecall_export_steps where intent_id=intent and payload->>'receipt_type'='credit' and (payload#>>'{line,unit_cost_cents}')::integer=-250) then raise exception 'credit material direction missing';end if;
 if not exists(select 1 from public.housecall_export_steps where intent_id=intent and payload->>'receipt_type'='debit' and (payload#>>'{line,unit_cost_cents}')::integer=500) then raise exception 'debit material direction missing';end if;
 select payload_hash into prior_hash from public.housecall_intents where id=intent;
 for item in select * from public.claim_receipt_type_classifications(actor,'1900-01-02',3) loop
  perform public.finish_receipt_type_classification((item->>'receiptId')::uuid,(item->>'leaseToken')::uuid,'credit','synthetic-model','synthetic-classifier','[]');
 end loop;
 if (select payload_hash from public.housecall_intents where id=intent)<>prior_hash then raise exception 'classification rewrote frozen export';end if;
 if (select review_version from public.receipts where id=rec)<>2 then raise exception 'classification did not invalidate open review';end if;
 if not exists(select 1 from public.reviews where receipt_id=rec and snapshot=draft) then raise exception 'classification rewrote manager decision';end if;
 if (public.receipt_type_classification_status('1900-01-02')->>'credit')::integer<>2 then raise exception 'backfill progress incorrect';end if;
 if exists(select 1 from public.claim_receipt_type_classifications(actor,'1900-01-02',3)) then raise exception 'completed classification replayed';end if;
 if has_function_privilege('authenticated','public.claim_receipt_type_classifications(uuid,timestamptz,integer)','execute') then raise exception 'browser may claim classifiers';end if;
end;$$;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','68300000-0000-4000-8000-000000000001',true);
do $$begin
 if not exists(select 1 from public.manager_review_queue(p_submitter=>'68300000-0000-4000-8000-000000000001')q where q->>'id'='68400000-0000-4000-8000-000000000002' and q->>'receiptType'='credit') then raise exception 'classified receipt absent from queue';end if;
end;$$;
reset role;
rollback;
