-- RA-25 forward remediation: make normalized readability evidence a required
-- precondition for completing readability work, and reject malformed provider
-- arrays with the stable invalid_request contract before performing casts.

create or replace function public.record_readability_result(
  p_work_id uuid,
  p_worker_id text,
  p_result jsonb,
  p_provider text,
  p_model text,
  p_usage jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  work_row public.work_items%rowtype;
  existing public.readability_checks%rowtype;
  is_readable boolean;
  failed_index_values jsonb;
  reason_values jsonb;
  failed_indexes smallint[];
  normalized_reasons text[];
  page_count integer;
  receipt_status text;
begin
  select * into work_row
  from public.work_items
  where id = p_work_id
  for update;

  if not found
    or work_row.kind is distinct from 'readability'
    or work_row.status is distinct from 'leased'
    or work_row.lease_owner is distinct from p_worker_id then
    raise exception 'conflict';
  end if;

  select * into existing
  from public.readability_checks
  where work_item_id = p_work_id;

  if found then
    return jsonb_build_object(
      'id', existing.id,
      'receiptId', existing.receipt_id,
      'readable', existing.readable
    );
  end if;

  if jsonb_typeof(p_result) is distinct from 'object'
    or jsonb_typeof(p_result->'schema_version') is distinct from 'number'
    or (p_result->'schema_version') is distinct from '1'::jsonb
    or jsonb_typeof(p_result->'readable') is distinct from 'boolean'
    or coalesce(jsonb_typeof(p_result->'failed_page_indexes'), 'array') is distinct from 'array'
    or coalesce(jsonb_typeof(p_result->'reasons'), 'array') is distinct from 'array'
    or coalesce(length(trim(p_provider)), 0) not between 1 and 80
    or coalesce(length(trim(p_model)), 0) not between 1 and 120
    or jsonb_typeof(coalesce(p_usage, '{}'::jsonb)) is distinct from 'object' then
    raise exception 'invalid_request';
  end if;

  failed_index_values := coalesce(p_result->'failed_page_indexes', '[]'::jsonb);
  reason_values := coalesce(p_result->'reasons', '[]'::jsonb);

  -- Validate the exact JSON element types and bounded values before any cast.
  -- Comparing JSON text is safe for strings, booleans, objects, arrays, null,
  -- decimals, exponents, and arbitrarily large numbers.
  if exists (
    select 1
    from jsonb_array_elements(failed_index_values) as item(value)
    where jsonb_typeof(item.value) is distinct from 'number'
      or item.value::text not in ('0', '1', '2', '3', '4')
  ) or exists (
    select 1
    from jsonb_array_elements(reason_values) as item(value)
    where jsonb_typeof(item.value) is distinct from 'string'
      or (item.value #>> '{}') not in (
        'blurry', 'too_dark', 'glare', 'cropped', 'rotated',
        'low_resolution', 'not_a_receipt', 'unreadable'
      )
  ) then
    raise exception 'invalid_request';
  end if;

  is_readable := (p_result->>'readable')::boolean;

  select coalesce(
    array_agg((item.value::text)::smallint order by (item.value::text)::smallint),
    '{}'::smallint[]
  )
  into failed_indexes
  from jsonb_array_elements(failed_index_values) as item(value);

  select coalesce(
    array_agg(item.value #>> '{}' order by item.value #>> '{}'),
    '{}'::text[]
  )
  into normalized_reasons
  from jsonb_array_elements(reason_values) as item(value);

  select count(*)::integer into page_count
  from public.receipt_pages
  where receipt_id = work_row.receipt_id
    and confirmed_at is not null;

  if page_count < 1
    or exists (
      select 1 from unnest(failed_indexes) as page_index
      where page_index < 0 or page_index >= page_count
    )
    or (is_readable and (cardinality(failed_indexes) > 0 or cardinality(normalized_reasons) > 0))
    or (not is_readable and (cardinality(failed_indexes) = 0 or cardinality(normalized_reasons) = 0)) then
    raise exception 'invalid_request';
  end if;

  select status into receipt_status
  from public.receipts
  where id = work_row.receipt_id
  for update;

  if not found or receipt_status is distinct from 'processing' then
    raise exception 'conflict';
  end if;

  insert into public.readability_checks (
    work_item_id,
    receipt_id,
    schema_version,
    provider,
    model,
    readable,
    failed_page_indexes,
    reasons,
    usage
  ) values (
    p_work_id,
    work_row.receipt_id,
    1,
    trim(p_provider),
    trim(p_model),
    is_readable,
    failed_indexes,
    normalized_reasons,
    coalesce(p_usage, '{}'::jsonb)
  )
  returning * into existing;

  if is_readable then
    insert into public.work_items (receipt_id, kind, status, next_attempt_at)
    values (work_row.receipt_id, 'extract', 'queued', now())
    on conflict (receipt_id, kind) do nothing;
  else
    update public.receipts
    set status = 'rejected_unreadable'
    where id = work_row.receipt_id
      and status = 'processing';
  end if;

  return jsonb_build_object(
    'id', existing.id,
    'receiptId', existing.receipt_id,
    'readable', existing.readable
  );
end;
$$;

create or replace function public.complete_work(
  p_work_id uuid,
  p_worker_id text
)
returns public.work_items
language plpgsql
security definer
set search_path = ''
as $$
declare
  rec public.work_items%rowtype;
begin
  select * into rec
  from public.work_items
  where id = p_work_id
  for update;

  if not found
    or rec.status is distinct from 'leased'
    or rec.lease_owner is distinct from p_worker_id then
    raise exception 'conflict';
  end if;

  if rec.kind = 'readability' and not exists (
    select 1
    from public.readability_checks as evidence
    where evidence.work_item_id = rec.id
      and evidence.receipt_id = rec.receipt_id
  ) then
    raise exception 'conflict';
  end if;

  update public.work_items
  set
    status = 'succeeded',
    lease_owner = null,
    lease_expires_at = null,
    last_error = null,
    terminal_reason = null
  where id = rec.id
  returning * into rec;

  perform public.append_audit_event(
    rec.receipt_id,
    'work_completed',
    jsonb_build_object('kind', rec.kind, 'attempt_count', rec.attempt_count),
    jsonb_build_object('status', rec.status),
    jsonb_build_object('worker_id', p_worker_id),
    'worker',
    null
  );

  return rec;
end;
$$;

revoke all on function public.record_readability_result(uuid, text, jsonb, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.complete_work(uuid, text)
  from public, anon, authenticated;

grant execute on function public.record_readability_result(uuid, text, jsonb, text, text, jsonb)
  to service_role;
grant execute on function public.complete_work(uuid, text)
  to service_role;
