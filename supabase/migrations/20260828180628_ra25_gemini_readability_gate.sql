-- RA-25: asynchronous visual readability gate. This stores only normalized
-- pass/retake evidence; receipt text and raw provider responses are excluded.

alter table public.work_items
  drop constraint work_items_kind_check;

alter table public.work_items
  add constraint work_items_kind_check check (kind in (
    'readability',
    'extract',
    'export',
    'purge'
  ));

create or replace function public.persistable_work_reason(p_reason text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case lower(trim(coalesce(p_reason, '')))
    when 'retention_hold' then 'retention_hold'
    when 'purge_not_eligible' then 'purge_not_eligible'
    when 'conflict' then 'conflict'
    when 'storage_object_still_present' then 'storage_object_still_present'
    when 'storage_object_existence_unknown' then 'storage_object_existence_unknown'
    when 'unhandled_work_kind' then 'unhandled_work_kind'
    when 'deferred' then 'deferred'
    when 'invalid_request' then 'invalid_request'
    when 'forbidden' then 'forbidden'
    when 'provider_timeout' then 'provider_timeout'
    when 'provider_rate_limited' then 'provider_rate_limited'
    when 'provider_unavailable' then 'provider_unavailable'
    when 'provider_invalid_response' then 'provider_invalid_response'
    when 'provider_empty_response' then 'provider_empty_response'
    when 'provider_authentication_failed' then 'provider_authentication_failed'
    when 'provider_request_rejected' then 'provider_request_rejected'
    when 'provider_not_configured' then 'provider_not_configured'
    when 'invalid_page_set' then 'invalid_page_set'
    when 'storage_object_missing' then 'storage_object_missing'
    when 'worker_failure' then 'worker_failure'
    else 'worker_failure'
  end;
$$;

create table public.readability_checks (
  id uuid primary key default gen_random_uuid(),
  work_item_id uuid not null unique references public.work_items (id) on delete cascade,
  receipt_id uuid not null references public.receipts (id) on delete cascade,
  schema_version integer not null,
  provider text not null,
  model text not null,
  readable boolean not null,
  failed_page_indexes smallint[] not null default '{}'::smallint[],
  reasons text[] not null default '{}'::text[],
  usage jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint readability_checks_schema_version_check check (schema_version = 1),
  constraint readability_checks_provider_check check (length(trim(provider)) between 1 and 80),
  constraint readability_checks_model_check check (length(trim(model)) between 1 and 120),
  constraint readability_checks_failed_page_indexes_check check (
    failed_page_indexes <@ array[0, 1, 2, 3, 4]::smallint[]
  ),
  constraint readability_checks_reasons_check check (
    reasons <@ array[
      'blurry',
      'too_dark',
      'glare',
      'cropped',
      'rotated',
      'low_resolution',
      'not_a_receipt',
      'unreadable'
    ]::text[]
  ),
  constraint readability_checks_result_shape_check check (
    (readable and cardinality(failed_page_indexes) = 0 and cardinality(reasons) = 0)
    or
    (not readable and cardinality(failed_page_indexes) > 0 and cardinality(reasons) > 0)
  ),
  constraint readability_checks_usage_object_check check (jsonb_typeof(usage) = 'object')
);

create index readability_checks_receipt_created_at_idx
  on public.readability_checks (receipt_id, created_at desc);

alter table public.readability_checks enable row level security;

create trigger readability_checks_append_only
  before update or delete on public.readability_checks
  for each row execute function public.reject_mutation();

-- The normalized provider evidence is server-only. Worker-facing reason copy is
-- returned by the authenticated receipt route after its ownership check.
revoke all on table public.readability_checks from public, anon, authenticated;
grant select, insert, delete on table public.readability_checks to service_role;

create or replace function public.after_receipt_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    perform public.append_audit_event(
      new.id,
      'receipt_status_changed',
      jsonb_build_object('status', old.status),
      jsonb_build_object('status', new.status),
      '{}'::jsonb
    );
  end if;

  if new.status = 'submitted' and old.status is distinct from 'submitted' then
    insert into public.work_items (receipt_id, kind, status, next_attempt_at)
    values (new.id, 'readability', 'queued', now())
    on conflict (receipt_id, kind) do nothing;
  end if;

  perform public.maybe_start_retention(new.id);
  return new;
end;
$$;

-- Before RA-25, submitted receipts could only have an unhandled extract job.
-- Replace those untouched placeholders with the new gate during deployment.
delete from public.work_items w
using public.receipts r
where w.receipt_id = r.id
  and w.kind = 'extract'
  and w.status = 'queued'
  and w.attempt_count = 0
  and r.status = 'submitted';

insert into public.work_items (receipt_id, kind, status, next_attempt_at)
select r.id, 'readability', 'queued', now()
from public.receipts r
where r.status = 'submitted'
on conflict (receipt_id, kind) do nothing;

create or replace function public.start_queued_work(
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
  receipt_status text;
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

  perform set_config('svl.correlation_id', public.current_correlation_id()::text, true);

  select r.status into receipt_status
  from public.receipts r
  where r.id = rec.receipt_id
  for update;

  if rec.kind = 'readability' then
    if receipt_status = 'submitted' then
      update public.receipts
      set status = 'processing'
      where id = rec.receipt_id
        and status = 'submitted';
    elsif receipt_status not in ('processing', 'rejected_unreadable', 'failed') then
      raise exception 'conflict';
    end if;
  elsif rec.kind = 'extract' then
    if receipt_status = 'submitted' then
      update public.receipts
      set status = 'processing'
      where id = rec.receipt_id
        and status = 'submitted';
    elsif receipt_status not in (
      'processing',
      'needs_review',
      'rejected_unreadable',
      'duplicate',
      'failed'
    ) then
      raise exception 'conflict';
    end if;
  elsif rec.kind = 'export' then
    if receipt_status = 'approved' then
      update public.receipts
      set status = 'exporting'
      where id = rec.receipt_id
        and status = 'approved';
    elsif receipt_status not in ('exporting', 'exported', 'partial_success', 'failed') then
      raise exception 'conflict';
    end if;
  end if;

  return rec;
end;
$$;

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
    or (p_result->>'schema_version') is distinct from '1'
    or jsonb_typeof(p_result->'readable') is distinct from 'boolean'
    or coalesce(jsonb_typeof(p_result->'failed_page_indexes'), 'array') is distinct from 'array'
    or coalesce(jsonb_typeof(p_result->'reasons'), 'array') is distinct from 'array'
    or nullif(trim(p_provider), '') is null
    or nullif(trim(p_model), '') is null
    or jsonb_typeof(coalesce(p_usage, '{}'::jsonb)) is distinct from 'object' then
    raise exception 'invalid_request';
  end if;

  is_readable := (p_result->>'readable')::boolean;
  select coalesce(array_agg(value::smallint order by value::integer), '{}'::smallint[])
    into failed_indexes
  from jsonb_array_elements_text(coalesce(p_result->'failed_page_indexes', '[]'::jsonb));
  select coalesce(array_agg(value order by value), '{}'::text[])
    into normalized_reasons
  from jsonb_array_elements_text(coalesce(p_result->'reasons', '[]'::jsonb));

  select count(*)::integer into page_count
  from public.receipt_pages
  where receipt_id = work_row.receipt_id
    and confirmed_at is not null;

  if page_count < 1
    or exists (
      select 1 from unnest(failed_indexes) as page_index
      where page_index < 0 or page_index >= page_count
    )
    or exists (
      select 1 from unnest(normalized_reasons) as reason
      where reason not in (
        'blurry', 'too_dark', 'glare', 'cropped', 'rotated',
        'low_resolution', 'not_a_receipt', 'unreadable'
      )
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

-- A provider/configuration failure can age into Failed, but only a normalized
-- unreadable result above may use rejected_unreadable.
create or replace function public.fail_dead_lettered_readability()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.kind = 'readability'
    and new.status = 'dead_letter'
    and old.status is distinct from 'dead_letter' then
    update public.receipts
    set status = 'failed'
    where id = new.receipt_id
      and status = 'processing';
  end if;
  return new;
end;
$$;

create trigger work_items_fail_dead_lettered_readability
  after update of status on public.work_items
  for each row execute function public.fail_dead_lettered_readability();

create or replace function public.delete_readability_checks_after_purge()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.content_deleted_at is not null
    and old.content_deleted_at is distinct from new.content_deleted_at then
    delete from public.readability_checks where receipt_id = new.id;
  end if;
  return new;
end;
$$;

create trigger receipts_delete_readability_after_purge
  after update of content_deleted_at on public.receipts
  for each row execute function public.delete_readability_checks_after_purge();

revoke all on function public.record_readability_result(uuid, text, jsonb, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.fail_dead_lettered_readability()
  from public, anon, authenticated;
revoke all on function public.delete_readability_checks_after_purge()
  from public, anon, authenticated;

grant execute on function public.record_readability_result(uuid, text, jsonb, text, text, jsonb)
  to service_role;
