-- RA-2 applied permission and execution checks.
-- Run as one transaction and roll back. Safe against populated databases.
-- npm run test:applied requires SVL_APPLIED_DATABASE_URL.

begin;

do $$
declare
  tbl text;
  fn_ident text;
  fn_sql text;
begin
  foreach tbl in array array[
    'public.profiles',
    'public.receipts',
    'public.extractions',
    'public.reviews',
    'public.receipt_lines',
    'public.job_candidates',
    'public.housecall_intents',
    'public.housecall_links',
    'public.export_attempts',
    'public.audit_events',
    'public.work_items',
    'public.housecall_outbox',
    'public.device_push_tokens'
  ]
  loop
    if has_table_privilege('anon', tbl, 'INSERT')
      or has_table_privilege('anon', tbl, 'UPDATE')
      or has_table_privilege('anon', tbl, 'DELETE') then
      raise exception 'anon must not mutate %', tbl;
    end if;
    if has_table_privilege('authenticated', tbl, 'INSERT')
      or has_table_privilege('authenticated', tbl, 'UPDATE')
      or has_table_privilege('authenticated', tbl, 'DELETE') then
      raise exception 'authenticated must not mutate %', tbl;
    end if;
    if has_table_privilege('anon', tbl, 'TRUNCATE') then
      raise exception 'anon must not truncate %', tbl;
    end if;
    if has_table_privilege('authenticated', tbl, 'TRUNCATE') then
      raise exception 'authenticated must not truncate %', tbl;
    end if;
  end loop;

  if not has_table_privilege('authenticated', 'public.receipts', 'SELECT') then
    raise exception 'authenticated must keep SELECT on receipts';
  end if;

  foreach fn_ident in array array[
    'submit_confirmed_receipt(uuid,uuid,text,integer,uuid)',
    'approve_receipt_with_outbox(uuid,uuid,jsonb,jsonb,uuid)',
    'claim_work(text,integer,integer,text[])',
    'defer_work(uuid,text,text)',
    'fail_work(uuid,text,text,boolean)',
    'purge_receipt_content(uuid,text)',
    'assert_purge_eligible(uuid,text)',
    'set_retention_hold(uuid,uuid,boolean,text,uuid)',
    'upsert_device_push_token(uuid,text,text)'
  ]
  loop
    if has_function_privilege('anon', fn_ident, 'EXECUTE') then
      raise exception 'anon must not execute %', fn_ident;
    end if;
    if has_function_privilege('authenticated', fn_ident, 'EXECUTE') then
      raise exception 'authenticated must not execute %', fn_ident;
    end if;
    if not has_function_privilege('service_role', fn_ident, 'EXECUTE') then
      raise exception 'service_role must execute %', fn_ident;
    end if;
  end loop;

  if public.persistable_work_reason('Authorization: Bearer TOPSECRET') is distinct from 'worker_failure' then
    raise exception 'persistable_work_reason must not keep provider secret text';
  end if;

  if not exists (
    select 1
    from storage.buckets b
    where b.id = 'receipts'
      and b.name = 'receipts'
      and b.public = false
      and b.file_size_limit = 10485760
      and b.allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']::text[]
  ) then
    raise exception 'receipts bucket must be created with private RA-17 limits';
  end if;

  select pg_get_functiondef('public.assert_purge_eligible(uuid,text)'::regprocedure)
  into fn_sql;
  if position('select * into work_row' in lower(fn_sql)) = 0
    or position('for update' in lower(fn_sql)) = 0
    or position('select * into rec' in lower(fn_sql)) = 0
    or position('select * into work_row' in lower(fn_sql))
      > position('for update' in lower(fn_sql))
    or position('for update' in lower(fn_sql))
      > position('select * into rec' in lower(fn_sql)) then
    raise exception 'assert_purge_eligible must lock work before receipt';
  end if;

  select pg_get_functiondef('public.purge_receipt_content(uuid,text)'::regprocedure)
  into fn_sql;
  if position('select * into work_row' in lower(fn_sql)) = 0
    or position('for update' in lower(fn_sql)) = 0
    or position('select * into rec' in lower(fn_sql)) = 0
    or position('select * into work_row' in lower(fn_sql))
      > position('for update' in lower(fn_sql))
    or position('for update' in lower(fn_sql))
      > position('select * into rec' in lower(fn_sql)) then
    raise exception 'purge_receipt_content must lock work before receipt';
  end if;

  select pg_get_functiondef('public.set_retention_hold(uuid,uuid,boolean,text,uuid)'::regprocedure)
  into fn_sql;
  if position('perform 1' in lower(fn_sql)) = 0
    or position('for update' in lower(fn_sql)) = 0
    or position('select * into rec' in lower(fn_sql)) = 0
    or position('perform 1' in lower(fn_sql))
      > position('for update' in lower(fn_sql))
    or position('for update' in lower(fn_sql))
      > position('select * into rec' in lower(fn_sql)) then
    raise exception 'set_retention_hold must lock purge work before receipt';
  end if;
end;
$$;

do $$
declare
  owner uuid;
  rcp_a uuid;
  rcp_b uuid;
  rcp_c uuid;
  rcp_d uuid;
  extraction_id uuid;
  line_id uuid;
  intent_id uuid;
  work_id uuid;
  storage_work uuid;
  conflict_work uuid;
  queued_work uuid;
  claimed_id uuid;
  audit_count integer;
  audit_after integer;
  audit_before_ref jsonb;
  audit_after_ref jsonb;
  audit_payload jsonb;
  started_at timestamptz;
  delete_at timestamptz;
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
    'ra2-' || replace(gen_random_uuid()::text, '-', '') || '@example.invalid',
    extensions.crypt('applied-test', extensions.gen_salt('bf')),
    now(),
    now(),
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    false,
    false,
    false
  )
  returning id into owner;

  perform public.upsert_device_push_token(
    owner,
    'ExpoPushToken[applied-test-xxxxxxxxxxxxxxxxxxxxxx]',
    'ios'
  );
  if not exists (
    select 1
    from public.device_push_tokens t
    where t.user_id = owner
      and t.expo_push_token = 'ExpoPushToken[applied-test-xxxxxxxxxxxxxxxxxxxxxx]'
      and t.platform = 'ios'
  ) then
    raise exception 'upsert_device_push_token did not persist the worker token';
  end if;

  update public.profiles set role = 'manager' where id = owner;

  insert into public.receipts (owner_user_id, status, storage_key, content_type)
  values (owner, 'needs_review', 'a/key.jpg', 'image/jpeg')
  returning id into rcp_a;

  perform public.approve_receipt_with_outbox(
    rcp_a,
    owner,
    jsonb_build_array(
      jsonb_build_object(
        'job_id', 'job-1',
        'description', 'pipe',
        'qty', 1,
        'unit_cost_cents', 100
      )
    ),
    null,
    gen_random_uuid()
  );

  if not exists (select 1 from public.reviews r where r.receipt_id = rcp_a and r.decision = 'approve')
    or not exists (select 1 from public.receipt_lines l where l.receipt_id = rcp_a)
    or not exists (select 1 from public.housecall_intents i where i.receipt_id = rcp_a)
    or not exists (select 1 from public.housecall_outbox o where o.receipt_id = rcp_a)
    or not exists (
      select 1 from public.work_items w
      where w.receipt_id = rcp_a and w.kind = 'export' and w.status = 'queued'
    ) then
    raise exception 'approve_receipt_with_outbox did not create review/lines/intent/outbox/export work';
  end if;

  select id into intent_id
  from public.housecall_intents
  where receipt_id = rcp_a
  order by created_at desc
  limit 1;

  select id into line_id
  from public.receipt_lines
  where receipt_id = rcp_a
  order by sort_index
  limit 1;

  insert into public.export_attempts (
    receipt_id, intent_id, housecall_job_id, step, status, idempotency_key
  ) values (rcp_a, intent_id, 'job-1', 'attachment', 'succeeded', 'idemp-attach-full');

  if exists (
    select 1 from public.receipts r where r.id = rcp_a and r.retention_started_at is not null
  ) then
    raise exception 'partial Housecall export must not start retention';
  end if;

  insert into public.export_attempts (
    receipt_id, receipt_line_id, intent_id, housecall_job_id, step, status, idempotency_key
  ) values (rcp_a, line_id, intent_id, 'job-1', 'job_cost', 'succeeded', 'idemp-job-full');

  select retention_started_at, delete_after_at
  into started_at, delete_at
  from public.receipts
  where id = rcp_a;

  if started_at is null then
    raise exception 'full current-intent export must start retention';
  end if;
  if delete_at is distinct from started_at + interval '365 days' then
    raise exception 'delete_after_at must be retention_started_at + 365 days';
  end if;

  insert into public.receipts (owner_user_id, status, storage_key, content_type)
  values (owner, 'needs_review', 'b/key.jpg', 'image/jpeg')
  returning id into rcp_b;

  perform public.approve_receipt_with_outbox(
    rcp_b,
    owner,
    jsonb_build_array(
      jsonb_build_object(
        'job_id', 'job-2',
        'description', 'valve',
        'qty', 1,
        'unit_cost_cents', 200
      )
    ),
    null,
    gen_random_uuid()
  );

  select id into intent_id
  from public.housecall_intents
  where receipt_id = rcp_b
  order by created_at desc
  limit 1;

  insert into public.export_attempts (
    receipt_id, intent_id, housecall_job_id, step, status, idempotency_key
  ) values (rcp_b, intent_id, 'job-2', 'attachment', 'succeeded', 'idemp-attach-partial');

  if exists (
    select 1 from public.receipts where id = rcp_b and retention_started_at is not null
  ) then
    raise exception 'partial export on a second receipt must not start retention';
  end if;

  insert into public.extractions (receipt_id, provider, lines, confidence)
  values (rcp_a, 'unknown', '[]'::jsonb, '{}'::jsonb)
  returning id into extraction_id;

  begin
    insert into public.receipt_lines (
      receipt_id, extraction_id, sort_index, description, qty, unit_cost_cents
    ) values (rcp_b, extraction_id, 99, 'cross', 1, 1);
    raise exception 'expected cross-receipt reference on receipt_lines';
  exception
    when raise_exception then
      if sqlerrm not like 'cross-receipt reference%' then
        raise;
      end if;
  end;

  update public.receipts
  set delete_after_at = now() - interval '1 day'
  where id = rcp_a;

  insert into public.work_items (receipt_id, kind, status, next_attempt_at)
  values (rcp_a, 'purge', 'queued', now())
  returning id into work_id;

  perform public.set_retention_hold(rcp_a, owner, true, 'applied test hold');
  select count(*) into audit_count
  from public.audit_events
  where receipt_id = rcp_a and action = 'retention_hold_set';

  perform public.set_retention_hold(rcp_a, owner, true, 'applied test hold');
  select count(*) into audit_after
  from public.audit_events
  where receipt_id = rcp_a and action = 'retention_hold_set';
  if audit_after <> audit_count then
    raise exception 'repeat hold must not write a false before-state audit';
  end if;

  perform public.set_retention_hold(rcp_a, owner, true, 'updated applied test hold');
  select count(*) into audit_after
  from public.audit_events
  where receipt_id = rcp_a and action = 'retention_hold_set';
  if audit_after <> audit_count + 1 then
    raise exception 'changing active hold metadata must append one audit event';
  end if;

  select before_ref, after_ref, payload
  into audit_before_ref, audit_after_ref, audit_payload
  from public.audit_events
  where receipt_id = rcp_a
    and action = 'retention_hold_set'
    and payload->>'change' = 'hold_metadata_updated';
  if audit_before_ref->>'reason' is distinct from 'applied test hold'
    or audit_after_ref->>'reason' is distinct from 'updated applied test hold'
    or audit_payload->>'change' is distinct from 'hold_metadata_updated' then
    raise exception 'hold metadata audit must contain truthful before/after values';
  end if;

  audit_count := audit_after;
  perform public.set_retention_hold(rcp_a, owner, true, 'updated applied test hold');
  select count(*) into audit_after
  from public.audit_events
  where receipt_id = rcp_a and action = 'retention_hold_set';
  if audit_after <> audit_count then
    raise exception 'repeat updated hold must remain an audit no-op';
  end if;

  select id into claimed_id
  from public.claim_work('test-worker', 10, 300, array['purge']::text[])
  where id = work_id;
  if claimed_id is not null then
    raise exception 'claim_work must not lease held purge work';
  end if;

  update public.work_items
  set
    status = 'leased',
    lease_owner = 'test-worker',
    lease_expires_at = now() + interval '5 minutes',
    attempt_count = 3
  where id = work_id;

  perform public.defer_work(work_id, 'test-worker', 'retention_hold');

  if exists (
    select 1 from public.work_items
    where id = work_id and (status is distinct from 'queued' or attempt_count <> 2)
  ) then
    raise exception 'defer_work must requeue without counting a failure';
  end if;

  select before_ref, after_ref, payload
  into audit_before_ref, audit_after_ref, audit_payload
  from public.audit_events
  where receipt_id = rcp_a
    and action = 'work_retried'
    and payload->>'worker_id' = 'test-worker'
    and payload->>'reason' = 'retention_hold';
  if audit_before_ref->>'status' is distinct from 'leased'
    or (audit_before_ref->>'attempt_count')::integer <> 3
    or audit_before_ref->>'lease_owner' is distinct from 'test-worker'
    or audit_after_ref->>'status' is distinct from 'queued'
    or (audit_after_ref->>'attempt_count')::integer <> 2
    or audit_after_ref->>'lease_owner' is not null
    or audit_after_ref->>'last_error' is distinct from 'retention_hold'
    or audit_payload->>'reason' is distinct from 'retention_hold' then
    raise exception 'defer_work audit must contain truthful before/after state';
  end if;

  update public.work_items
  set
    status = 'leased',
    lease_owner = 'test-worker',
    lease_expires_at = now() + interval '5 minutes'
  where id = work_id;

  perform public.fail_work(work_id, 'test-worker', 'Authorization: Bearer TOPSECRET', true);

  if (select last_error from public.work_items where id = work_id) is distinct from 'worker_failure' then
    raise exception 'fail_work must persist worker_failure instead of secret text';
  end if;
  if exists (
    select 1 from public.audit_events
    where receipt_id = rcp_a
      and payload::text like '%TOPSECRET%'
  ) then
    raise exception 'audit payload must not contain the secret';
  end if;

  update public.work_items
  set
    status = 'dead_letter',
    terminal_reason = 'retention_hold',
    last_error = 'retention_hold',
    attempt_count = 8
  where id = work_id;

  select count(*) into audit_count
  from public.audit_events
  where receipt_id = rcp_a and action = 'work_retried';

  perform public.set_retention_hold(rcp_a, owner, false, null);

  if exists (
    select 1 from public.work_items
    where id = work_id and (status is distinct from 'queued' or attempt_count <> 0)
  ) then
    raise exception 'clearing a hold must revive hold-caused dead letters with a fresh retry budget';
  end if;

  select count(*) into audit_after
  from public.audit_events
  where receipt_id = rcp_a and action = 'work_retried';
  if audit_after <> audit_count + 1 then
    raise exception 'hold-clear dead-letter recovery must append one work retry audit';
  end if;

  select before_ref, after_ref, payload
  into audit_before_ref, audit_after_ref, audit_payload
  from public.audit_events
  where receipt_id = rcp_a
    and action = 'work_retried'
    and before_ref->>'work_id' = work_id::text
    and payload->>'reason' = 'retention_hold_cleared';
  if audit_before_ref->>'status' is distinct from 'dead_letter'
    or (audit_before_ref->>'attempt_count')::integer <> 8
    or audit_before_ref->>'terminal_reason' is distinct from 'retention_hold'
    or audit_after_ref->>'status' is distinct from 'queued'
    or (audit_after_ref->>'attempt_count')::integer <> 0
    or audit_after_ref->>'terminal_reason' is not null
    or audit_payload->>'reason' is distinct from 'retention_hold_cleared' then
    raise exception 'hold-clear work audit must contain truthful recovery state';
  end if;

  select count(*) into audit_count
  from public.audit_events
  where receipt_id = rcp_a and action = 'retention_hold_cleared';
  perform public.set_retention_hold(rcp_a, owner, false, null);
  select count(*) into audit_after
  from public.audit_events
  where receipt_id = rcp_a and action = 'retention_hold_cleared';
  if audit_after <> audit_count then
    raise exception 'repeat hold clear must not write a false before-state audit';
  end if;

  update public.receipts
  set
    retention_started_at = now() - interval '400 days',
    delete_after_at = now() - interval '1 day'
  where id = rcp_b;

  insert into public.work_items (
    receipt_id, kind, status, next_attempt_at, attempt_count, last_error, terminal_reason
  ) values (
    rcp_b, 'purge', 'dead_letter', now(), 8, 'storage_object_still_present', 'storage_object_still_present'
  )
  returning id into storage_work;

  perform public.set_retention_hold(rcp_b, owner, true, 'other hold');
  perform public.set_retention_hold(rcp_b, owner, false, null);

  if exists (
    select 1 from public.work_items where id = storage_work and status is distinct from 'dead_letter'
  ) then
    raise exception 'hold clear must not revive non-hold dead letters';
  end if;

  insert into public.receipts (
    owner_user_id, status, storage_key, content_type, retention_started_at, delete_after_at
  ) values (
    owner, 'exported', 'c/key.jpg', 'image/jpeg', now() - interval '400 days', now() - interval '1 day'
  )
  returning id into rcp_c;

  insert into public.work_items (
    receipt_id, kind, status, next_attempt_at, attempt_count, last_error, terminal_reason
  ) values (
    rcp_c, 'purge', 'dead_letter', now(), 8, 'conflict', 'conflict'
  )
  returning id into conflict_work;

  select count(*) into audit_count
  from public.audit_events
  where receipt_id = rcp_c and action = 'work_retried';
  perform public.set_retention_hold(rcp_c, owner, true, 'temporary conflict test hold');
  perform public.set_retention_hold(rcp_c, owner, false, null);
  select count(*) into audit_after
  from public.audit_events
  where receipt_id = rcp_c and action = 'work_retried';

  if exists (
    select 1
    from public.work_items
    where id = conflict_work
      and (
        status is distinct from 'dead_letter'
        or attempt_count <> 8
        or terminal_reason is distinct from 'conflict'
      )
  ) or audit_after <> audit_count then
    raise exception 'hold clear must never revive or audit an unrelated conflict dead letter';
  end if;

  insert into public.receipts (
    owner_user_id, status, storage_key, content_type, retention_started_at, delete_after_at
  ) values (
    owner, 'exported', 'd/key.jpg', 'image/jpeg', now(), now() + interval '1 day'
  )
  returning id into rcp_d;

  insert into public.work_items (
    receipt_id, kind, status, next_attempt_at, attempt_count, last_error
  ) values (
    rcp_d, 'purge', 'queued', now(), 5, 'retention_hold'
  )
  returning id into queued_work;

  perform public.set_retention_hold(rcp_d, owner, true, 'queued recovery audit');
  select count(*) into audit_count
  from public.audit_events
  where receipt_id = rcp_d and action = 'work_retried';
  perform public.set_retention_hold(rcp_d, owner, false, null);
  select count(*) into audit_after
  from public.audit_events
  where receipt_id = rcp_d and action = 'work_retried';

  if audit_after <> audit_count + 1 then
    raise exception 'hold-clear queued recovery must append one work retry audit';
  end if;

  select before_ref, after_ref, payload
  into audit_before_ref, audit_after_ref, audit_payload
  from public.audit_events
  where receipt_id = rcp_d
    and action = 'work_retried'
    and before_ref->>'work_id' = queued_work::text
    and payload->>'reason' = 'retention_hold_cleared';
  if audit_before_ref->>'work_id' is distinct from queued_work::text
    or audit_before_ref->>'status' is distinct from 'queued'
    or (audit_before_ref->>'attempt_count')::integer <> 5
    or audit_before_ref->>'last_error' is distinct from 'retention_hold'
    or audit_after_ref->>'status' is distinct from 'queued'
    or (audit_after_ref->>'attempt_count')::integer <> 5
    or audit_after_ref->>'last_error' is not null
    or audit_payload->>'reason' is distinct from 'retention_hold_cleared' then
    raise exception 'hold-clear queued audit must preserve attempt and truthfully clear the hold reason';
  end if;

  select id into claimed_id
  from public.claim_work('purge-worker', 10, 300, array['purge']::text[])
  where id = work_id;
  if claimed_id is distinct from work_id then
    raise exception 'claim_work must lease due recovered purge work';
  end if;

  select before_ref, after_ref, payload
  into audit_before_ref, audit_after_ref, audit_payload
  from public.audit_events
  where receipt_id = rcp_a
    and action = 'work_started'
    and payload->>'worker_id' = 'purge-worker';
  if audit_before_ref->>'status' is distinct from 'queued'
    or (audit_before_ref->>'attempt_count')::integer <> 0
    or audit_after_ref->>'status' is distinct from 'leased'
    or (audit_after_ref->>'attempt_count')::integer <> 1
    or audit_after_ref->>'lease_owner' is distinct from 'purge-worker'
    or audit_payload->>'worker_id' is distinct from 'purge-worker'
    or (audit_payload->>'stale_lease_recovered')::boolean is distinct from false then
    raise exception 'claim_work must audit truthful attempt and lease state';
  end if;

  perform public.assert_purge_eligible(rcp_a, 'purge-worker');
  perform public.purge_receipt_content(rcp_a, 'purge-worker');

  if exists (select 1 from public.receipt_lines where receipt_id = rcp_a)
    or exists (select 1 from public.reviews where receipt_id = rcp_a)
    or exists (select 1 from public.extractions where receipt_id = rcp_a)
    or exists (
      select 1 from public.receipts
      where id = rcp_a and (content_deleted_at is null or storage_key is not null)
    ) then
    raise exception 'purge_receipt_content must remove extraction/review content';
  end if;
end;
$$;

rollback;
