-- Synthetic fixtures and all resulting receipt/work records are rolled back.
begin;
do $$
declare
  actor uuid := gen_random_uuid();
  receipt uuid := gen_random_uuid();
  email_receipt uuid := gen_random_uuid();
  email_id uuid := gen_random_uuid();
  token uuid;
  pages jsonb;
  confirmed jsonb;
  result jsonb;
  invalid_seen boolean;
begin
  insert into auth.users(id,aud,role,email,raw_app_meta_data)
  values(actor,'authenticated','authenticated','test-ten-pages-'||actor||'@example.invalid',
    '{"svl_access_approved":true}'::jsonb);
  update public.profiles set role='admin' where id=actor;
  select jsonb_agg(jsonb_build_object('pageIndex',i,'storageKey',actor||'/'||receipt||'/TEST-page-'||i||'.jpg',
    'contentType','image/jpeg','originalFilename','TEST-page-'||i||'.jpg') order by i),
    jsonb_agg(jsonb_build_object('pageIndex',i,'checksum',repeat('a',64),'byteSize',100) order by i)
  into pages, confirmed from generate_series(0,9) i;

  result := public.create_upload_pending_receipt_set(actor,receipt,pages);
  if (result->>'pageCount')::integer <> 10 or
    (select count(*) from public.receipt_pages where receipt_id=receipt) <> 10 then
    raise exception 'Ten pages were not created';
  end if;
  -- Contiguous and complete manifests are still required.
  invalid_seen := false;
  begin
    perform public.submit_confirmed_receipt_set(receipt,actor,confirmed - 9,repeat('b',64),900);
  exception when others then
    if sqlerrm <> 'conflict' then raise; end if;
    invalid_seen := true;
  end;
  if not invalid_seen then raise exception 'Partial confirmation accepted'; end if;
  result := public.submit_confirmed_receipt_set(receipt,actor,confirmed,repeat('b',64),1000);
  if result->>'status' <> 'submitted' or
    (select count(*) from public.receipt_pages where receipt_id=receipt and confirmed_at is not null) <> 10 then
    raise exception 'Ten pages were not confirmed';
  end if;
  perform public.submit_confirmed_receipt_set(receipt,actor,confirmed,repeat('b',64),1000);

  invalid_seen := false;
  begin
    perform public.create_upload_pending_receipt_set(actor,gen_random_uuid(),pages ||
      jsonb_build_array(jsonb_build_object('pageIndex',10,'storageKey','TEST-eleventh.jpg','contentType','image/jpeg')));
  exception when others then
    if sqlerrm <> 'invalid_request' then raise; end if;
    invalid_seen := true;
  end;
  if not invalid_seen then raise exception 'Eleven-page upload accepted'; end if;
  invalid_seen := false;
  begin
    perform public.submit_confirmed_receipt_set(receipt,actor,confirmed ||
      jsonb_build_array(jsonb_build_object('pageIndex',10,'checksum',repeat('c',64),'byteSize',100)),repeat('b',64),1100);
  exception when others then
    if sqlerrm <> 'invalid_request' then raise; end if;
    invalid_seen := true;
  end;
  if not invalid_seen then raise exception 'Eleven-page confirmation accepted'; end if;
  invalid_seen := false;
  begin
    insert into public.receipt_pages(receipt_id,page_index,storage_key,content_type)
    values(receipt,10,actor||'/'||receipt||'/TEST-eleventh.jpg','image/jpeg');
  exception when check_violation then invalid_seen := true;
  end;
  if not invalid_seen then raise exception 'Eleventh page index accepted'; end if;

  -- The email commit uses the same ten-page upload and confirmation path.
  insert into public.email_receipt_imports(id,mailbox,message_id,checksum,byte_size,owner_user_id,status)
  values(email_id,'recisvl@gmail.com','test_ten_pages_'||email_id,repeat('d',64),1000,actor,'queued');
  select lease_token into token from public.claim_email_receipt_import(email_id);
  select jsonb_agg((pages->i) || (confirmed->i) ||
    jsonb_build_object('storageKey',actor||'/'||email_receipt||'/TEST-page-'||i||'.jpg') order by i)
  into pages from generate_series(0,9) i;
  perform public.commit_email_receipts(email_id,token,jsonb_build_array(jsonb_build_object(
    'receiptId',email_receipt,'filename','TEST-ten-pages.pdf','manifestChecksum',repeat('e',64),
    'totalBytes',1000,'pages',pages)),'test@example.invalid','TEST ten pages',now());
  if (select status from public.email_receipt_imports where id=email_id) <> 'imported' or
    (select count(*) from public.receipt_pages where receipt_id=email_receipt and confirmed_at is not null) <> 10 or
    not exists(select 1 from public.work_items where receipt_id=email_receipt and kind='readability') then
    raise exception 'Ten-page email did not enter the receipt workflow';
  end if;
  if exists(select 1 from public.housecall_intents where receipt_id in (receipt,email_receipt)) then
    raise exception 'Test intake bypassed manager approval';
  end if;
  if has_function_privilege('authenticated','public.create_upload_pending_receipt_set(uuid,uuid,jsonb,double precision,double precision,double precision,timestamptz,uuid)','EXECUTE') or
    has_function_privilege('anon','public.submit_confirmed_receipt_set(uuid,uuid,jsonb,text,bigint,uuid)','EXECUTE') then
    raise exception 'Upload RPC client privileges expanded';
  end if;
end;
$$;
rollback;
