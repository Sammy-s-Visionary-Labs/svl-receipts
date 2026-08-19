-- RA-2 follow-up: persist only allowlisted work error codes, defer hold/not-due
-- without swallowing unexpected SQL failures, and revive only hold-caused purge work.

create or replace function public.persistable_work_reason(p_reason text)
returns text
language sql
immutable
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
    when 'worker_failure' then 'worker_failure'
    else 'worker_failure'
  end;
$$;

create or replace function public.fail_work(
  p_work_id uuid,
  p_worker_id text,
  p_reason text,
  p_retryable boolean default true
)
returns public.work_items
language plpgsql
security definer
set search_path = public
as $$
declare
  rec public.work_items%rowtype;
  next_status text;
  next_at timestamptz;
  reason text;
begin
  reason := public.persistable_work_reason(p_reason);

  select * into rec
  from public.work_items
  where id = p_work_id
  for update;

  if not found or rec.status is distinct from 'leased' or rec.lease_owner is distinct from p_worker_id then
    raise exception 'conflict';
  end if;

  if p_retryable = false or rec.attempt_count >= 8 then
    next_status := 'dead_letter';
    next_at := now();
  else
    next_status := 'queued';
    next_at := now() + least(interval '1 day', interval '1 minute' * (2 ^ (rec.attempt_count - 1)));
  end if;

  update public.work_items
  set
    status = next_status,
    next_attempt_at = next_at,
    lease_owner = null,
    lease_expires_at = null,
    last_error = reason,
    terminal_reason = case when next_status = 'dead_letter' then reason else null end
  where id = p_work_id
  returning * into rec;

  perform public.append_audit_event(
    rec.receipt_id,
    case when rec.status = 'dead_letter' then 'work_dead_lettered' else 'work_retried' end,
    jsonb_build_object('kind', rec.kind, 'attempt_count', rec.attempt_count),
    jsonb_build_object('status', rec.status, 'next_attempt_at', rec.next_attempt_at),
    jsonb_build_object('worker_id', p_worker_id, 'reason', reason),
    'worker',
    null
  );

  return rec;
end;
$$;

create or replace function public.defer_work(
  p_work_id uuid,
  p_worker_id text,
  p_reason text default 'deferred'
)
returns public.work_items
language plpgsql
security definer
set search_path = public
as $$
declare
  rec public.work_items%rowtype;
  reason text;
begin
  reason := public.persistable_work_reason(p_reason);

  select * into rec
  from public.work_items
  where id = p_work_id
  for update;

  if not found
    or rec.status is distinct from 'leased'
    or rec.lease_owner is distinct from p_worker_id then
    raise exception 'conflict';
  end if;

  update public.work_items
  set
    status = 'queued',
    next_attempt_at = now() + interval '1 hour',
    lease_owner = null,
    lease_expires_at = null,
    last_error = reason,
    terminal_reason = null,
    attempt_count = greatest(rec.attempt_count - 1, 0)
  where id = p_work_id
  returning * into rec;

  perform public.append_audit_event(
    rec.receipt_id,
    'work_retried',
    jsonb_build_object('kind', rec.kind, 'attempt_count', rec.attempt_count),
    jsonb_build_object('status', rec.status, 'next_attempt_at', rec.next_attempt_at),
    jsonb_build_object('worker_id', p_worker_id, 'reason', reason),
    'worker',
    null
  );

  return rec;
end;
$$;

create or replace function public.assert_purge_eligible(
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

  if not found
    or work_row.status is distinct from 'leased'
    or work_row.lease_owner is distinct from p_worker_id then
    raise exception 'conflict';
  end if;

  if rec.content_deleted_at is not null then
    return jsonb_build_object(
      'id', rec.id,
      'storageKey', rec.storage_key,
      'alreadyPurged', true
    );
  end if;

  if rec.retention_hold then
    raise exception 'retention_hold';
  end if;

  if rec.delete_after_at is null or rec.delete_after_at > now() then
    raise exception 'purge_not_eligible';
  end if;

  update public.receipts
  set
    purge_claimed_at = now(),
    purge_claimed_by = p_worker_id
  where id = p_receipt_id
    and content_deleted_at is null
    and retention_hold = false
  returning * into rec;

  if not found then
    raise exception 'conflict';
  end if;

  return jsonb_build_object(
    'id', rec.id,
    'storageKey', rec.storage_key,
    'alreadyPurged', false
  );
end;
$$;

create or replace function public.set_retention_hold(
  p_receipt_id uuid,
  p_actor_id uuid,
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
  perform public.require_active_actor(p_actor_id, array['manager', 'admin']);
  perform set_config('svl.correlation_id', p_correlation_id::text, true);
  perform set_config('svl.actor_id', p_actor_id::text, true);

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

    if rec.retention_hold then
      if rec.retention_hold_owner_id is distinct from p_actor_id
        or rec.retention_hold_reason is distinct from reason then
        update public.receipts
        set
          retention_hold_owner_id = p_actor_id,
          retention_hold_reason = reason
        where id = p_receipt_id
        returning * into rec;
      end if;
      return jsonb_build_object(
        'id', rec.id,
        'retentionHold', rec.retention_hold,
        'deleteAfterAt', rec.delete_after_at
      );
    end if;

    if rec.purge_claimed_at is not null and rec.content_deleted_at is null then
      raise exception 'conflict';
    end if;

    update public.receipts
    set
      retention_hold = true,
      retention_hold_owner_id = p_actor_id,
      retention_hold_reason = reason
    where id = p_receipt_id
      and (purge_claimed_at is null or content_deleted_at is not null)
    returning * into rec;
    if not found then
      raise exception 'conflict';
    end if;
    perform public.append_audit_event(
      rec.id,
      'retention_hold_set',
      jsonb_build_object('retention_hold', false),
      jsonb_build_object('retention_hold', true, 'owner_id', rec.retention_hold_owner_id),
      jsonb_build_object('reason', reason)
    );
  else
    if not rec.retention_hold then
      return jsonb_build_object(
        'id', rec.id,
        'retentionHold', rec.retention_hold,
        'deleteAfterAt', rec.delete_after_at
      );
    end if;

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

    update public.work_items
    set
      next_attempt_at = greatest(coalesce(rec.delete_after_at, now()), now())
    where receipt_id = p_receipt_id
      and kind = 'purge'
      and status = 'queued'
      and rec.content_deleted_at is null
      and rec.delete_after_at is not null;

    update public.work_items
    set
      status = 'queued',
      next_attempt_at = greatest(coalesce(rec.delete_after_at, now()), now()),
      last_error = null,
      terminal_reason = null,
      lease_owner = null,
      lease_expires_at = null,
      attempt_count = 0
    where receipt_id = p_receipt_id
      and kind = 'purge'
      and status = 'dead_letter'
      and rec.content_deleted_at is null
      and rec.delete_after_at is not null
      and (
        terminal_reason in ('retention_hold', 'conflict')
        or last_error in ('retention_hold', 'conflict')
      );
  end if;

  return jsonb_build_object(
    'id', rec.id,
    'retentionHold', rec.retention_hold,
    'deleteAfterAt', rec.delete_after_at
  );
end;
$$;

revoke all on function public.persistable_work_reason(text) from public, anon, authenticated;
revoke all on function public.fail_work(uuid, text, text, boolean) from public, anon, authenticated;
revoke all on function public.defer_work(uuid, text, text) from public, anon, authenticated;
revoke all on function public.assert_purge_eligible(uuid, text) from public, anon, authenticated;
revoke all on function public.set_retention_hold(uuid, uuid, boolean, text, uuid) from public, anon, authenticated;

grant execute on function public.fail_work(uuid, text, text, boolean) to service_role;
grant execute on function public.defer_work(uuid, text, text) to service_role;
grant execute on function public.assert_purge_eligible(uuid, text) to service_role;
grant execute on function public.set_retention_hold(uuid, uuid, boolean, text, uuid) to service_role;
