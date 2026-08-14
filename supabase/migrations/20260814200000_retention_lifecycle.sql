-- RA-19: 365-day retention from the submitted start event, holds, and content purge.
-- Housecall links / intents / export attempts / audit events are kept.

alter table public.work_items
  drop constraint work_items_kind_check;

alter table public.work_items
  add constraint work_items_kind_check check (kind in (
    'extract',
    'export',
    'purge'
  ));

alter table public.receipts
  add column retention_policy_version integer not null default 1,
  add column retention_starts_at timestamptz,
  add column delete_after_at timestamptz,
  add column retention_hold boolean not null default false,
  add column retention_hold_owner_id uuid references auth.users (id),
  add column retention_hold_reason text,
  add column content_deleted_at timestamptz,
  add constraint receipts_retention_policy_version_check check (retention_policy_version >= 1),
  add constraint receipts_retention_hold_check check (
    (
      retention_hold = false
      and retention_hold_owner_id is null
      and retention_hold_reason is null
    )
    or (
      retention_hold = true
      and retention_hold_owner_id is not null
      and coalesce(length(trim(retention_hold_reason)), 0) > 0
    )
  );

create index receipts_delete_after_at_idx
  on public.receipts (delete_after_at)
  where content_deleted_at is null and retention_hold = false;

update public.receipts
set
  retention_starts_at = submitted_at,
  delete_after_at = submitted_at + interval '365 days'
where submitted_at is not null
  and retention_starts_at is null;

create or replace function public.reject_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' and current_setting('svl.allow_purge', true) = 'true' then
    return old;
  end if;
  raise exception '% is append-only', tg_table_name;
end;
$$;

create or replace function public.submit_confirmed_receipt(
  p_receipt_id uuid,
  p_checksum text,
  p_byte_size integer,
  p_correlation_id uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  rec public.receipts%rowtype;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated';
  end if;

  perform set_config('svl.correlation_id', p_correlation_id::text, true);

  select * into rec
  from public.receipts
  where id = p_receipt_id
  for update;

  if not found then
    raise exception 'forbidden';
  end if;

  if rec.owner_user_id is distinct from auth.uid() then
    raise exception 'forbidden';
  end if;

  if rec.status = 'submitted' and rec.checksum is not distinct from p_checksum then
    return jsonb_build_object('id', rec.id, 'status', rec.status);
  end if;

  if rec.status is distinct from 'upload_pending' then
    raise exception 'conflict';
  end if;

  update public.receipts
  set
    status = 'submitted',
    checksum = p_checksum,
    byte_size = p_byte_size,
    submitted_at = now(),
    retention_policy_version = 1,
    retention_starts_at = now(),
    delete_after_at = now() + interval '365 days'
  where id = p_receipt_id
    and status = 'upload_pending'
  returning * into rec;

  if not found then
    select * into rec from public.receipts where id = p_receipt_id;
    return jsonb_build_object('id', rec.id, 'status', rec.status);
  end if;

  return jsonb_build_object('id', rec.id, 'status', rec.status);
end;
$$;

create or replace function public.set_retention_hold(
  p_receipt_id uuid,
  p_hold boolean,
  p_reason text default null,
  p_correlation_id uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  rec public.receipts%rowtype;
  reason text;
begin
  if public.current_user_role() not in ('manager', 'admin') then
    raise exception 'forbidden';
  end if;

  perform set_config('svl.correlation_id', p_correlation_id::text, true);

  select * into rec
  from public.receipts
  where id = p_receipt_id
  for update;

  if not found then
    raise exception 'forbidden';
  end if;

  if p_hold then
    reason := nullif(trim(p_reason), '');
    if reason is null then
      raise exception 'invalid_request';
    end if;
    update public.receipts
    set
      retention_hold = true,
      retention_hold_owner_id = auth.uid(),
      retention_hold_reason = reason
    where id = p_receipt_id
    returning * into rec;
    perform public.append_audit_event(
      rec.id,
      'retention_hold_set',
      jsonb_build_object('retention_hold', false),
      jsonb_build_object(
        'retention_hold', true,
        'owner_id', rec.retention_hold_owner_id
      ),
      jsonb_build_object('reason', reason)
    );
  else
    update public.receipts
    set
      retention_hold = false,
      retention_hold_owner_id = null,
      retention_hold_reason = null
    where id = p_receipt_id
    returning * into rec;
    perform public.append_audit_event(
      rec.id,
      'retention_hold_cleared',
      jsonb_build_object('retention_hold', true),
      jsonb_build_object('retention_hold', false),
      '{}'::jsonb
    );
  end if;

  return jsonb_build_object(
    'id', rec.id,
    'retentionHold', rec.retention_hold,
    'deleteAfterAt', rec.delete_after_at
  );
end;
$$;

create or replace function public.enqueue_due_purges()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted integer;
begin
  insert into public.work_items (receipt_id, kind, status, next_attempt_at)
  select r.id, 'purge', 'queued', now()
  from public.receipts r
  where r.retention_starts_at is not null
    and r.delete_after_at is not null
    and r.delete_after_at <= now()
    and r.retention_hold = false
    and r.content_deleted_at is null
  on conflict (receipt_id, kind) do nothing;

  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

create or replace function public.purge_receipt_content(
  p_receipt_id uuid,
  p_worker_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  rec public.receipts%rowtype;
  work_row public.work_items%rowtype;
begin
  select * into rec
  from public.receipts
  where id = p_receipt_id
  for update;

  if not found then
    raise exception 'conflict';
  end if;

  select * into work_row
  from public.work_items
  where receipt_id = p_receipt_id
    and kind = 'purge'
  for update;

  if rec.content_deleted_at is not null then
    return jsonb_build_object('id', rec.id, 'contentDeletedAt', rec.content_deleted_at);
  end if;

  if rec.retention_hold or rec.delete_after_at is null or rec.delete_after_at > now() then
    raise exception 'conflict';
  end if;

  perform set_config('svl.allow_purge', 'true', true);

  delete from public.job_candidates where receipt_id = p_receipt_id;
  delete from public.receipt_lines where receipt_id = p_receipt_id;
  delete from public.reviews where receipt_id = p_receipt_id;
  delete from public.extractions where receipt_id = p_receipt_id;

  update public.receipts
  set
    storage_key = null,
    original_filename = null,
    checksum = null,
    byte_size = null,
    content_type = null,
    content_deleted_at = now()
  where id = p_receipt_id
  returning * into rec;

  perform public.append_audit_event(
    rec.id,
    'content_purged',
    jsonb_build_object('content_deleted', false),
    jsonb_build_object('content_deleted', true),
    jsonb_build_object('worker_id', p_worker_id),
    'worker',
    null
  );

  return jsonb_build_object('id', rec.id, 'contentDeletedAt', rec.content_deleted_at);
end;
$$;

grant execute on function public.submit_confirmed_receipt(uuid, text, integer, uuid) to authenticated, service_role;
grant execute on function public.set_retention_hold(uuid, boolean, text, uuid) to authenticated, service_role;

revoke all on function public.enqueue_due_purges() from public, anon, authenticated;
revoke all on function public.purge_receipt_content(uuid, text) from public, anon, authenticated;
revoke all on function public.set_retention_hold(uuid, boolean, text, uuid) from public, anon;
grant execute on function public.enqueue_due_purges() to service_role;
grant execute on function public.purge_receipt_content(uuid, text) to service_role;
grant execute on function public.set_retention_hold(uuid, boolean, text, uuid) to authenticated, service_role;
