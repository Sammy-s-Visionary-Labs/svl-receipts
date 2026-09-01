-- RA-25 applied-schema and lifecycle tests. Every mutation is rolled back.

begin;

do $$
begin
  if not exists (
    select 1 from pg_tables
    where schemaname = 'public'
      and tablename = 'readability_checks'
      and rowsecurity
  ) then
    raise exception 'readability_checks must exist with RLS enabled';
  end if;

  if has_table_privilege('anon', 'public.readability_checks', 'SELECT,INSERT,UPDATE,DELETE')
    or has_table_privilege('authenticated', 'public.readability_checks', 'SELECT,INSERT,UPDATE,DELETE') then
    raise exception 'readability evidence must remain server-only';
  end if;

  if has_function_privilege(
      'authenticated',
      'record_readability_result(uuid,text,jsonb,text,text,jsonb)',
      'EXECUTE'
    )
    or not has_function_privilege(
      'service_role',
      'record_readability_result(uuid,text,jsonb,text,text,jsonb)',
      'EXECUTE'
  ) then
    raise exception 'record_readability_result privilege boundary is incorrect';
  end if;

  if has_function_privilege(
      'authenticated',
      'complete_work(uuid,text)',
      'EXECUTE'
    )
    or not has_function_privilege(
      'service_role',
      'complete_work(uuid,text)',
      'EXECUTE'
    ) then
    raise exception 'complete_work privilege boundary is incorrect';
  end if;

  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join lateral unnest(coalesce(p.proconfig, '{}'::text[])) as setting(value)
    where n.nspname = 'public'
      and p.proname in ('record_readability_result', 'complete_work')
      and setting.value in ('search_path=', 'search_path=""')
    group by n.nspname
    having count(distinct p.proname) = 2
  ) then
    raise exception 'RA-25 privileged functions must use an empty search_path';
  end if;
end;
$$;

do $$
declare
  owner uuid;
  readable_receipt uuid := gen_random_uuid();
  unreadable_receipt uuid := gen_random_uuid();
  outage_receipt uuid := gen_random_uuid();
  readable_work uuid := gen_random_uuid();
  unreadable_work uuid := gen_random_uuid();
  outage_work uuid := gen_random_uuid();
begin
  insert into auth.users (
    instance_id,
    id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    created_at,
    updated_at,
    raw_app_meta_data,
    raw_user_meta_data,
    is_super_admin,
    is_sso_user,
    is_anonymous
  ) values (
    '00000000-0000-0000-0000-000000000000',
    gen_random_uuid(),
    'authenticated',
    'authenticated',
    'ra25-' || replace(gen_random_uuid()::text, '-', '') || '@example.invalid',
    extensions.crypt('applied-test', extensions.gen_salt('bf')),
    now(),
    now(),
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    false,
    false,
    false
  ) returning id into owner;

  insert into public.receipts (id, owner_user_id, status, submitted_at)
  values
    (readable_receipt, owner, 'submitted', now()),
    (unreadable_receipt, owner, 'submitted', now()),
    (outage_receipt, owner, 'submitted', now());

  insert into public.receipt_pages (
    receipt_id, page_index, storage_key, content_type, checksum, byte_size, confirmed_at
  ) values
    (readable_receipt, 0, owner || '/' || readable_receipt || '/page-0.jpg', 'image/jpeg', repeat('a', 64), 100, now()),
    (unreadable_receipt, 0, owner || '/' || unreadable_receipt || '/page-0.jpg', 'image/jpeg', repeat('b', 64), 100, now()),
    (outage_receipt, 0, owner || '/' || outage_receipt || '/page-0.jpg', 'image/jpeg', repeat('c', 64), 100, now());

  insert into public.work_items (
    id, receipt_id, kind, status, attempt_count, next_attempt_at, lease_owner, lease_expires_at
  ) values
    (readable_work, readable_receipt, 'readability', 'leased', 1, now(), 'ra25-readable', now() + interval '5 minutes'),
    (unreadable_work, unreadable_receipt, 'readability', 'leased', 1, now(), 'ra25-unreadable', now() + interval '5 minutes'),
    (outage_work, outage_receipt, 'readability', 'leased', 1, now(), 'ra25-outage', now() + interval '5 minutes');

  perform public.start_queued_work(readable_work, 'ra25-readable');
  perform public.record_readability_result(
    readable_work,
    'ra25-readable',
    '{"schema_version":1,"readable":true}'::jsonb,
    'google_gemini',
    'gemini-3.5-flash-lite',
    '{"inputTokens":1120,"outputTokens":20}'::jsonb
  );
  perform public.complete_work(readable_work, 'ra25-readable');

  if not exists (
    select 1 from public.readability_checks
    where receipt_id = readable_receipt and readable
  ) or not exists (
    select 1 from public.work_items
    where receipt_id = readable_receipt and kind = 'extract' and status = 'queued'
  ) or not exists (
    select 1 from public.receipts
    where id = readable_receipt and status = 'processing'
  ) then
    raise exception 'a readable receipt must persist evidence and continue to extraction';
  end if;

  perform public.start_queued_work(unreadable_work, 'ra25-unreadable');
  perform public.record_readability_result(
    unreadable_work,
    'ra25-unreadable',
    '{"schema_version":1,"readable":false,"failed_page_indexes":[0],"reasons":["blurry","cropped"]}'::jsonb,
    'google_gemini',
    'gemini-3.5-flash-lite',
    '{}'::jsonb
  );
  perform public.complete_work(unreadable_work, 'ra25-unreadable');

  if not exists (
    select 1 from public.receipts
    where id = unreadable_receipt and status = 'rejected_unreadable'
  ) or exists (
    select 1 from public.work_items
    where receipt_id = unreadable_receipt and kind = 'extract'
  ) then
    raise exception 'an unreadable receipt must request a retake and skip extraction';
  end if;

  perform public.start_queued_work(outage_work, 'ra25-outage');
  perform public.fail_work(outage_work, 'ra25-outage', 'provider_unavailable', true);

  if not exists (
    select 1 from public.work_items
    where id = outage_work
      and status = 'queued'
      and last_error = 'provider_unavailable'
  ) or not exists (
    select 1 from public.receipts
    where id = outage_receipt and status = 'processing'
  ) or exists (
    select 1 from public.readability_checks where receipt_id = outage_receipt
  ) then
    raise exception 'provider outage must retry without a false unreadable result';
  end if;
end;
$$;

-- Adversarial result-shape, completion-invariant, queue, dead-letter,
-- append-only, idempotency, and purge probes.
do $$
declare
  owner uuid;
  result_receipt uuid := gen_random_uuid();
  result_work uuid := gen_random_uuid();
  missing_receipt uuid := gen_random_uuid();
  missing_work uuid := gen_random_uuid();
  queued_receipt uuid := gen_random_uuid();
  bad_result jsonb;
  bad_results jsonb[] := array[
    '{"schema_version":"1","readable":true}'::jsonb,
    '{"schema_version":1,"readable":false,"failed_page_indexes":["0"],"reasons":["blurry"]}'::jsonb,
    '{"schema_version":1,"readable":false,"failed_page_indexes":[0.5],"reasons":["blurry"]}'::jsonb,
    '{"schema_version":1,"readable":false,"failed_page_indexes":[5],"reasons":["blurry"]}'::jsonb,
    '{"schema_version":1,"readable":false,"failed_page_indexes":[32768],"reasons":["blurry"]}'::jsonb,
    '{"schema_version":1,"readable":false,"failed_page_indexes":[999999999999999999999999999999],"reasons":["blurry"]}'::jsonb,
    '{"schema_version":1,"readable":false,"failed_page_indexes":[null],"reasons":["blurry"]}'::jsonb,
    '{"schema_version":1,"readable":false,"failed_page_indexes":[{}],"reasons":["blurry"]}'::jsonb,
    '{"schema_version":1,"readable":false,"failed_page_indexes":[true],"reasons":["blurry"]}'::jsonb,
    '{"schema_version":1,"readable":false,"failed_page_indexes":[0],"reasons":[0]}'::jsonb,
    '{"schema_version":1,"readable":false,"failed_page_indexes":[0],"reasons":[null]}'::jsonb,
    '{"schema_version":1,"readable":false,"failed_page_indexes":[0],"reasons":[{}]}'::jsonb,
    '{"schema_version":1,"readable":false,"failed_page_indexes":[0],"reasons":[true]}'::jsonb,
    '{"schema_version":1,"readable":false,"failed_page_indexes":[0],"reasons":["vendor_reason"]}'::jsonb
  ];
  first_result jsonb;
  replay_result jsonb;
begin
  insert into auth.users (
    instance_id,
    id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    created_at,
    updated_at,
    raw_app_meta_data,
    raw_user_meta_data,
    is_super_admin,
    is_sso_user,
    is_anonymous
  ) values (
    '00000000-0000-0000-0000-000000000000',
    gen_random_uuid(),
    'authenticated',
    'authenticated',
    'ra25-adversarial-' || replace(gen_random_uuid()::text, '-', '') || '@example.invalid',
    extensions.crypt('applied-test', extensions.gen_salt('bf')),
    now(),
    now(),
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    false,
    false,
    false
  ) returning id into owner;

  insert into public.receipts (id, owner_user_id, status, submitted_at)
  values
    (result_receipt, owner, 'submitted', now()),
    (missing_receipt, owner, 'submitted', now()),
    (queued_receipt, owner, 'upload_pending', null);

  insert into public.receipt_pages (
    receipt_id, page_index, storage_key, content_type, checksum, byte_size, confirmed_at
  ) values
    (result_receipt, 0, owner || '/' || result_receipt || '/page-0.jpg', 'image/jpeg', repeat('d', 64), 100, now()),
    (missing_receipt, 0, owner || '/' || missing_receipt || '/page-0.jpg', 'image/jpeg', repeat('e', 64), 100, now()),
    (queued_receipt, 0, owner || '/' || queued_receipt || '/page-0.jpg', 'image/jpeg', repeat('f', 64), 100, now());

  insert into public.work_items (
    id, receipt_id, kind, status, attempt_count, next_attempt_at, lease_owner, lease_expires_at
  ) values
    (result_work, result_receipt, 'readability', 'leased', 1, now(), 'ra25-result', now() + interval '5 minutes'),
    (missing_work, missing_receipt, 'readability', 'leased', 8, now(), 'ra25-missing', now() + interval '5 minutes');

  perform public.start_queued_work(result_work, 'ra25-result');

  foreach bad_result in array bad_results
  loop
    begin
      perform public.record_readability_result(
        result_work,
        'ra25-result',
        bad_result,
        'google_gemini',
        'gemini-3.5-flash-lite',
        '{}'::jsonb
      );
      raise exception 'malformed readability result was accepted: %', bad_result;
    exception
      when others then
        if sqlerrm is distinct from 'invalid_request' then
          raise exception 'malformed readability result returned %, expected invalid_request: %',
            sqlerrm, bad_result;
        end if;
    end;
  end loop;

  begin
    perform public.record_readability_result(
      result_work,
      'ra25-result',
      '{"schema_version":1,"readable":true}'::jsonb,
      repeat('p', 81),
      'gemini-3.5-flash-lite',
      '{}'::jsonb
    );
    raise exception 'oversized provider was accepted';
  exception
    when others then
      if sqlerrm is distinct from 'invalid_request' then
        raise exception 'oversized provider returned %, expected invalid_request', sqlerrm;
      end if;
  end;

  begin
    perform public.record_readability_result(
      result_work,
      'ra25-result',
      '{"schema_version":1,"readable":true}'::jsonb,
      'google_gemini',
      'gemini-3.5-flash-lite',
      '[]'::jsonb
    );
    raise exception 'non-object usage was accepted';
  exception
    when others then
      if sqlerrm is distinct from 'invalid_request' then
        raise exception 'non-object usage returned %, expected invalid_request', sqlerrm;
      end if;
  end;

  if exists (
    select 1 from public.readability_checks where work_item_id = result_work
  ) or exists (
    select 1 from public.work_items
    where receipt_id = result_receipt and kind = 'extract'
  ) then
    raise exception 'invalid provider results must have no durable side effects';
  end if;

  first_result := public.record_readability_result(
    result_work,
    'ra25-result',
    '{"schema_version":1,"readable":true}'::jsonb,
    'google_gemini',
    'gemini-3.5-flash-lite',
    '{"inputTokens":100,"outputTokens":10}'::jsonb
  );
  replay_result := public.record_readability_result(
    result_work,
    'ra25-result',
    '{"schema_version":1,"readable":true}'::jsonb,
    'google_gemini',
    'gemini-3.5-flash-lite',
    '{"inputTokens":100,"outputTokens":10}'::jsonb
  );

  if first_result is distinct from replay_result
    or (select count(*) from public.readability_checks where work_item_id = result_work) <> 1
    or (select count(*) from public.work_items where receipt_id = result_receipt and kind = 'extract') <> 1 then
    raise exception 'readability result recording must be idempotent';
  end if;

  perform public.complete_work(result_work, 'ra25-result');

  begin
    update public.readability_checks
    set provider = 'tampered'
    where work_item_id = result_work;
    raise exception 'readability evidence update was accepted';
  exception
    when others then
      if sqlerrm not like '%append-only%' then
        raise exception 'readability update returned %, expected append-only rejection', sqlerrm;
      end if;
  end;

  begin
    delete from public.readability_checks where work_item_id = result_work;
    raise exception 'readability evidence delete was accepted';
  exception
    when others then
      if sqlerrm not like '%append-only%' then
        raise exception 'readability delete returned %, expected append-only rejection', sqlerrm;
      end if;
  end;

  perform public.start_queued_work(missing_work, 'ra25-missing');
  begin
    perform public.complete_work(missing_work, 'ra25-missing');
    raise exception 'readability work completed without evidence';
  exception
    when others then
      if sqlerrm is distinct from 'conflict' then
        raise exception 'missing-evidence completion returned %, expected conflict', sqlerrm;
      end if;
  end;

  if not exists (
    select 1 from public.work_items
    where id = missing_work and status = 'leased' and lease_owner = 'ra25-missing'
  ) or exists (
    select 1 from public.audit_events
    where receipt_id = missing_receipt and action = 'work_completed'
  ) then
    raise exception 'failed completion must preserve the lease and omit completion audit';
  end if;

  perform public.fail_work(missing_work, 'ra25-missing', 'provider_invalid_response', true);

  if not exists (
    select 1 from public.work_items
    where id = missing_work
      and status = 'dead_letter'
      and terminal_reason = 'provider_invalid_response'
  ) or not exists (
    select 1 from public.receipts
    where id = missing_receipt and status = 'failed'
  ) then
    raise exception 'dead-lettered readability must fail its receipt without evidence';
  end if;

  update public.receipts
  set status = 'submitted', submitted_at = now()
  where id = queued_receipt and status = 'upload_pending';

  if not exists (
    select 1 from public.work_items
    where receipt_id = queued_receipt and kind = 'readability' and status = 'queued'
  ) or exists (
    select 1 from public.work_items
    where receipt_id = queued_receipt and kind = 'extract'
  ) then
    raise exception 'submission must queue readability before extraction';
  end if;

  perform set_config('svl.allow_purge', 'true', true);
  update public.receipts
  set content_deleted_at = now()
  where id = result_receipt;
  perform set_config('svl.allow_purge', '', true);

  if exists (
    select 1 from public.readability_checks where work_item_id = result_work
  ) or exists (
    select 1 from public.receipt_pages where receipt_id = result_receipt
  ) then
    raise exception 'content purge must remove readability evidence and page metadata';
  end if;
end;
$$;

rollback;
