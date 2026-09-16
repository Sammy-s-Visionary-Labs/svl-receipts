begin;
insert into auth.users(id,aud,role,email,raw_app_meta_data) values
 ('92000000-0000-4000-8000-000000000001','authenticated','authenticated','email-admin@example.invalid','{"svl_access_approved":true}'),
 ('92000000-0000-4000-8000-000000000002','authenticated','authenticated','email-worker@example.invalid','{"svl_access_approved":true}');
update public.profiles set role='admin' where id='92000000-0000-4000-8000-000000000001';
insert into public.email_receipt_imports(id,mailbox,message_id,checksum,byte_size,owner_user_id,status)
 values('92100000-0000-4000-8000-000000000001','recisvl@gmail.com','email_test_1',repeat('a',64),100,'92000000-0000-4000-8000-000000000001','queued');
set local role service_role;
do $$
declare item public.email_receipt_imports%rowtype; docs jsonb; receipt uuid:='92200000-0000-4000-8000-000000000001';
begin
 select * into item from public.claim_email_receipt_import('92100000-0000-4000-8000-000000000001');
 if item.lease_token is null then raise exception 'import not claimed'; end if;
 if exists(select 1 from public.claim_email_receipt_import(item.id)) then raise exception 'concurrent import claim allowed'; end if;
 docs:=jsonb_build_array(jsonb_build_object('receiptId',receipt,'filename','TEST EMAIL.pdf','manifestChecksum',repeat('b',64),'totalBytes',100,
 'pages',jsonb_build_array(jsonb_build_object('pageIndex',0,'storageKey','92000000-0000-4000-8000-000000000001/'||receipt||'/test.jpg','contentType','image/jpeg','checksum',repeat('c',64),'byteSize',100))));
 begin perform public.commit_email_receipts(item.id,gen_random_uuid(),docs,'test@example.invalid','TEST RECEIPT',now());raise exception 'wrong lease accepted';exception when others then if sqlerrm<>'conflict_email_lease' then raise;end if;end;
 perform public.commit_email_receipts(item.id,item.lease_token,docs,'test@example.invalid','TEST RECEIPT',now());
 if (select status from public.email_receipt_imports where id=item.id)<>'imported' then raise exception 'not imported';end if;
 if (select status from public.receipts where id=receipt)<>'submitted' or not exists(select 1 from public.receipt_pages where receipt_id=receipt and confirmed_at is not null) then raise exception 'receipt not confirmed';end if;
 if not exists(select 1 from public.work_items where receipt_id=receipt and kind='readability') then raise exception 'OCR not queued';end if;
 if exists(select 1 from public.housecall_outbox where receipt_id=receipt) then raise exception 'email bypassed manager';end if;
 if exists(select 1 from public.claim_email_receipt_import(item.id)) then raise exception 'committed email repeated';end if;
end;$$;
reset role;
insert into public.receipts(id,owner_user_id,status,submitted_at) values
 ('92200000-0000-4000-8000-000000000002','92000000-0000-4000-8000-000000000001','needs_review',now()),
 ('92200000-0000-4000-8000-000000000003','92000000-0000-4000-8000-000000000001','needs_review',now()),
 ('92200000-0000-4000-8000-000000000004','92000000-0000-4000-8000-000000000001','needs_review',now());
insert into public.extractions(receipt_id,provider,vendor,purchase_date,receipt_total_cents,invoice_number) values
 ('92200000-0000-4000-8000-000000000002','gemini','TEST Email Yard','2026-09-16',8000,'TEST-EMAIL-A'),
 ('92200000-0000-4000-8000-000000000003','gemini','TEST Email Yard','2026-09-16',8000,'TEST-EMAIL-A'),
 ('92200000-0000-4000-8000-000000000004','gemini','TEST Email Yard','2026-09-16',8000,'TEST-DIFFERENT');
set local role service_role;
do $$
declare receipt uuid:='92200000-0000-4000-8000-000000000002'; candidate uuid;
begin
 perform public.refresh_receipt_duplicate_candidates(receipt);
 if not exists(select 1 from public.duplicate_candidates where receipt_id=receipt and candidate_receipt_id='92200000-0000-4000-8000-000000000003') then raise exception 'cross-source duplicate missed';end if;
 if exists(select 1 from public.duplicate_candidates where receipt_id=receipt and candidate_receipt_id='92200000-0000-4000-8000-000000000004') then raise exception 'different transaction falsely matched';end if;
 begin insert into public.reviews(receipt_id,actor_id,decision) values(receipt,'92000000-0000-4000-8000-000000000001','approve');raise exception 'unresolved duplicate approved';exception when others then if sqlerrm<>'duplicate_review_required' then raise;end if;end;
 -- Dismissing a false match is an explicit, audited manager decision.
 select id into candidate from public.duplicate_candidates where receipt_id=receipt and candidate_receipt_id='92200000-0000-4000-8000-000000000003';
 perform public.dismiss_duplicate_candidate(candidate,'92000000-0000-4000-8000-000000000001');
 insert into public.reviews(receipt_id,actor_id,decision) values(receipt,'92000000-0000-4000-8000-000000000001','approve');
 if not exists(select 1 from public.duplicate_candidate_decisions where candidate_id=candidate) then raise exception 'dismissal unaudited';end if;
end;$$;
reset role;
-- Fingerprints survive removal of approved originals, and a shared original is
-- retained until every linked document completes content retention.
insert into public.receipt_categories(id,label) values('email_retention_test','Test materials');
insert into public.receipts(id,owner_user_id,status,submitted_at) values
 ('92200000-0000-4000-8000-000000000005','92000000-0000-4000-8000-000000000001','needs_review',now()),
 ('92200000-0000-4000-8000-000000000006','92000000-0000-4000-8000-000000000001','needs_review',now());
set local role service_role;
do $$
declare snap jsonb:='{"vendor":"TEST RETAINED EMAIL","invoiceNumber":"TEST-RETAINED-1","category":"email_retention_test","referenceTotal":"80.00","lines":[]}';
begin
 insert into public.reviews(receipt_id,actor_id,decision,snapshot) values('92200000-0000-4000-8000-000000000005','92000000-0000-4000-8000-000000000001','approve',snap);
 update public.receipts set status='exported',content_deleted_at=now() where id='92200000-0000-4000-8000-000000000005';
 begin
  insert into public.reviews(receipt_id,actor_id,decision,snapshot) values('92200000-0000-4000-8000-000000000006','92000000-0000-4000-8000-000000000001','approve',snap);
  raise exception 'purged purchase allowed twice';
 exception when others then if sqlerrm<>'retained_purchase_duplicate' then raise;end if;end;
 if exists(select 1 from public.purgeable_email_originals()) then raise exception 'email removed before receipt retention';end if;
 update public.receipts set content_deleted_at=now() where id='92200000-0000-4000-8000-000000000001';
 if not exists(select 1 from public.purgeable_email_originals()) then raise exception 'retained email not eligible for purge';end if;
 perform public.retire_email_original('92100000-0000-4000-8000-000000000001');
 if exists(select 1 from public.email_receipt_imports where raw_deleted_at is null or sender is not null or subject is not null) then raise exception 'email metadata not retired';end if;
 if not exists(select 1 from public.email_receipt_imports where message_id='email_test_1') then raise exception 'message replay fence removed';end if;
end;$$;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','92000000-0000-4000-8000-000000000002',true);
do $$begin
 if exists(select 1 from public.email_receipt_imports) or exists(select 1 from public.email_receipt_documents) then raise exception 'worker read mailbox data';end if;
 if has_function_privilege('authenticated','public.commit_email_receipts(uuid,uuid,jsonb,text,text,timestamptz)','EXECUTE') or has_function_privilege('anon','public.claim_email_receipt_import(uuid)','EXECUTE') then raise exception 'import privilege leaked';end if;
end;$$;
select set_config('request.jwt.claim.sub','92000000-0000-4000-8000-000000000001',true);
do $$begin if not exists(select 1 from public.email_receipt_imports) then raise exception 'admin cannot inspect imports';end if;end;$$;
rollback;
