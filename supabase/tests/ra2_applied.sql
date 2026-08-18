-- RA-2 applied permission and execution checks.
-- Run as one transaction and roll back. Safe against populated databases.

begin;

do $$
declare
  fn_ident text;
begin
  if has_table_privilege('anon', 'public.receipts', 'INSERT')
    or has_table_privilege('anon', 'public.receipts', 'UPDATE')
    or has_table_privilege('anon', 'public.receipts', 'DELETE') then
    raise exception 'anon must not mutate receipts';
  end if;

  if has_table_privilege('authenticated', 'public.receipts', 'INSERT')
    or has_table_privilege('authenticated', 'public.receipts', 'UPDATE')
    or has_table_privilege('authenticated', 'public.receipts', 'DELETE') then
    raise exception 'authenticated must not mutate receipts';
  end if;

  if not has_table_privilege('authenticated', 'public.receipts', 'SELECT') then
    raise exception 'authenticated must keep SELECT on receipts';
  end if;

  foreach fn_ident in array array[
    'submit_confirmed_receipt(uuid,uuid,text,integer,uuid)',
    'approve_receipt_with_outbox(uuid,uuid,jsonb,jsonb,uuid)',
    'claim_work(text,integer,integer,text[])',
    'defer_work(uuid,text,text)',
    'purge_receipt_content(uuid,text)',
    'set_retention_hold(uuid,uuid,boolean,text,uuid)'
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
end;
$$;

do $$
declare
  owner uuid;
  receipt_a uuid := gen_random_uuid();
  receipt_b uuid := gen_random_uuid();
  extraction_a uuid;
  intent_a uuid;
  intent_b uuid;
  work_id uuid;
  claimed_id uuid;
  redacted jsonb;
begin
  select id into owner from auth.users limit 1;
  if owner is null then
    raise notice 'skipping row-level RA-2 checks; no auth.users row';
    return;
  end if;

  insert into public.receipts (id, owner_user_id, status, storage_key, content_type)
  values
    (receipt_a, owner, 'needs_review', 'a/key.jpg', 'image/jpeg'),
    (receipt_b, owner, 'approved', 'b/key.jpg', 'image/jpeg');

  begin
    insert into public.housecall_intents (
      receipt_id, payload_version, attachment_job_ids, job_cost_lines
    ) values (receipt_a, 1, '[]'::jsonb, '[]'::jsonb)
    returning id into intent_a;

    insert into public.housecall_links (
      receipt_id, intent_id, housecall_job_id, step, external_id
    ) values (receipt_a, intent_a, 'job-1', 'attachment', 'ext-1');

    insert into public.export_attempts (
      receipt_id, intent_id, housecall_job_id, step, status, idempotency_key
    ) values (receipt_a, intent_a, 'job-1', 'attachment', 'pending', 'idemp-1');
  exception
    when undefined_column then
      raise exception 'record "new" has no field: %', sqlerrm;
  end;

  insert into public.extractions (receipt_id, provider, lines, confidence)
  values (receipt_a, 'unknown', '[]'::jsonb, '{}'::jsonb)
  returning id into extraction_a;

  begin
    insert into public.receipt_lines (
      receipt_id, extraction_id, sort_index, description, qty, unit_cost_cents
    ) values (receipt_b, extraction_a, 0, 'pipe', 1, 100);
    raise exception 'expected cross-receipt reference on receipt_lines';
  exception
    when raise_exception then
      if sqlerrm not like 'cross-receipt reference%' then
        raise;
      end if;
  end;

  insert into public.housecall_intents (
    receipt_id, payload_version, attachment_job_ids, job_cost_lines
  ) values (receipt_b, 1, '[]'::jsonb, '[]'::jsonb)
  returning id into intent_b;

  begin
    insert into public.housecall_outbox (receipt_id, intent_id, status)
    values (receipt_b, intent_a, 'pending');
    raise exception 'expected cross-receipt reference on housecall_outbox';
  exception
    when raise_exception then
      if sqlerrm not like 'cross-receipt reference%' then
        raise;
      end if;
  end;

  update public.profiles set role = 'manager' where id = owner;

  update public.receipts
  set
    retention_started_at = now() - interval '400 days',
    delete_after_at = now() - interval '1 day'
  where id = receipt_a;

  perform public.set_retention_hold(receipt_a, owner, true, 'applied test hold');

  insert into public.work_items (receipt_id, kind, status, next_attempt_at)
  values (receipt_a, 'purge', 'queued', now())
  returning id into work_id;

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

  perform public.defer_work(work_id, 'test-worker', 'conflict');

  if exists (
    select 1 from public.work_items
    where id = work_id and (status is distinct from 'queued' or attempt_count <> 2)
  ) then
    raise exception 'defer_work must requeue without counting a failure';
  end if;

  update public.work_items
  set status = 'dead_letter', terminal_reason = 'conflict', attempt_count = 8
  where id = work_id;

  update public.profiles set role = 'manager' where id = owner;
  perform public.set_retention_hold(receipt_a, owner, false, null);

  if exists (
    select 1 from public.work_items
    where id = work_id and status is distinct from 'queued'
  ) then
    raise exception 'clearing hold must revive purge work';
  end if;

  redacted := public.redact_audit_json(
    jsonb_build_object('vendor', 'Select', 'api_key', 'sk-live', 'nested', jsonb_build_object('raw_text', 'ocr'))
  );
  if redacted->>'api_key' is distinct from '[redacted]'
    or redacted->'nested'->>'raw_text' is distinct from '[redacted]'
    or redacted->>'vendor' is distinct from 'Select' then
    raise exception 'redact_audit_json did not match domain keys';
  end if;
end;
$$;

rollback;
