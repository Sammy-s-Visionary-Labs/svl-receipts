-- RA-2 follow-up: make every work attempt and hold recovery auditable with
-- truthful before/after snapshots, keep purge RPC lock ordering consistent,
-- and make the private receipt bucket reproducible on a clean Supabase project.

alter table public.audit_events
  drop constraint if exists audit_events_action_check;

alter table public.audit_events
  add constraint audit_events_action_check check (action in (
    'receipt_created',
    'receipt_status_changed',
    'review_recorded',
    'receipt_approved',
    'outbox_enqueued',
    'work_started',
    'work_completed',
    'work_retried',
    'work_dead_lettered',
    'external_attempt',
    'retention_hold_set',
    'retention_hold_cleared',
    'content_purged'
  ));

create or replace function public.claim_work(
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 300,
  p_kinds text[] default array['purge']::text[]
)
returns setof public.work_items
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed record;
  item public.work_items%rowtype;
begin
  if p_worker_id is null or length(trim(p_worker_id)) = 0 then
    raise exception 'invalid_request';
  end if;
  if p_kinds is null or cardinality(p_kinds) = 0 then
    raise exception 'invalid_request';
  end if;

  for claimed in
    with picked as materialized (
      select
        w.id,
        w.status as old_status,
        w.attempt_count as old_attempt_count,
        w.next_attempt_at as old_next_attempt_at,
        w.lease_owner as old_lease_owner,
        w.lease_expires_at as old_lease_expires_at,
        w.last_error as old_last_error,
        w.terminal_reason as old_terminal_reason
      from public.work_items w
      left join public.receipts r on r.id = w.receipt_id
      where w.status in ('queued', 'leased')
        and w.kind = any (p_kinds)
        and w.next_attempt_at <= now()
        and (
          w.status = 'queued'
          or w.lease_expires_at is null
          or w.lease_expires_at < now()
        )
        and not (
          w.kind = 'purge'
          and (
            r.id is null
            or r.retention_hold = true
            or r.content_deleted_at is not null
            or r.delete_after_at is null
            or r.delete_after_at > now()
          )
        )
      order by w.next_attempt_at asc, w.created_at asc
      for update of w skip locked
      limit greatest(coalesce(p_limit, 10), 1)
    ), leased as (
      update public.work_items w
      set
        status = 'leased',
        lease_owner = p_worker_id,
        lease_expires_at = now() + make_interval(secs => coalesce(p_lease_seconds, 300)),
        attempt_count = w.attempt_count + 1
      from picked
      where w.id = picked.id
      returning
        w as item,
        picked.old_status,
        picked.old_attempt_count,
        picked.old_next_attempt_at,
        picked.old_lease_owner,
        picked.old_lease_expires_at,
        picked.old_last_error,
        picked.old_terminal_reason
    )
    select * from leased
  loop
    item := claimed.item;

    perform public.append_audit_event(
      item.receipt_id,
      'work_started',
      jsonb_build_object(
        'kind', item.kind,
        'status', claimed.old_status,
        'attempt_count', claimed.old_attempt_count,
        'next_attempt_at', claimed.old_next_attempt_at,
        'lease_owner', claimed.old_lease_owner,
        'lease_expires_at', claimed.old_lease_expires_at,
        'last_error', claimed.old_last_error,
        'terminal_reason', claimed.old_terminal_reason
      ),
      jsonb_build_object(
        'kind', item.kind,
        'status', item.status,
        'attempt_count', item.attempt_count,
        'next_attempt_at', item.next_attempt_at,
        'lease_owner', item.lease_owner,
        'lease_expires_at', item.lease_expires_at,
        'last_error', item.last_error,
        'terminal_reason', item.terminal_reason
      ),
      jsonb_build_object(
        'worker_id', p_worker_id,
        'stale_lease_recovered', claimed.old_status = 'leased'
      ),
      'worker',
      null
    );

    return next item;
  end loop;

  return;
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
  before_work public.work_items%rowtype;
  after_work public.work_items%rowtype;
  reason text;
begin
  reason := public.persistable_work_reason(p_reason);

  select * into before_work
  from public.work_items
  where id = p_work_id
  for update;

  if not found
    or before_work.status is distinct from 'leased'
    or before_work.lease_owner is distinct from p_worker_id then
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
    attempt_count = greatest(before_work.attempt_count - 1, 0)
  where id = p_work_id
  returning * into after_work;

  perform public.append_audit_event(
    after_work.receipt_id,
    'work_retried',
    jsonb_build_object(
      'kind', before_work.kind,
      'status', before_work.status,
      'attempt_count', before_work.attempt_count,
      'next_attempt_at', before_work.next_attempt_at,
      'lease_owner', before_work.lease_owner,
      'lease_expires_at', before_work.lease_expires_at,
      'last_error', before_work.last_error,
      'terminal_reason', before_work.terminal_reason
    ),
    jsonb_build_object(
      'kind', after_work.kind,
      'status', after_work.status,
      'attempt_count', after_work.attempt_count,
      'next_attempt_at', after_work.next_attempt_at,
      'lease_owner', after_work.lease_owner,
      'lease_expires_at', after_work.lease_expires_at,
      'last_error', after_work.last_error,
      'terminal_reason', after_work.terminal_reason
    ),
    jsonb_build_object('worker_id', p_worker_id, 'reason', reason),
    'worker',
    null
  );

  return after_work;
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
  -- Work lifecycle RPCs lock the work item first. Keep this order before the
  -- receipt lock so a stale worker and a lease-recovery claim cannot deadlock.
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

  select * into rec
  from public.receipts
  where id = p_receipt_id
  for update;

  if not found then
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
  before_receipt public.receipts%rowtype;
  before_work public.work_items%rowtype;
  after_work public.work_items%rowtype;
  reason text;
  retry_at timestamptz;
begin
  perform public.require_active_actor(p_actor_id, array['manager', 'admin']);
  perform set_config('svl.correlation_id', p_correlation_id::text, true);
  perform set_config('svl.actor_id', p_actor_id::text, true);

  -- claim_work, fail/defer/complete, and the purge RPCs all lock work first.
  -- Pre-lock the receipt's unique purge item before locking the receipt so hold
  -- changes cannot invert that order during a concurrent lease transition.
  perform 1
  from public.work_items
  where receipt_id = p_receipt_id
    and kind = 'purge'
  for update;

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
        before_receipt := rec;
        update public.receipts
        set
          retention_hold_owner_id = p_actor_id,
          retention_hold_reason = reason
        where id = p_receipt_id
        returning * into rec;

        perform public.append_audit_event(
          rec.id,
          'retention_hold_set',
          jsonb_build_object(
            'retention_hold', before_receipt.retention_hold,
            'owner_id', before_receipt.retention_hold_owner_id,
            'reason', before_receipt.retention_hold_reason
          ),
          jsonb_build_object(
            'retention_hold', rec.retention_hold,
            'owner_id', rec.retention_hold_owner_id,
            'reason', rec.retention_hold_reason
          ),
          jsonb_build_object('change', 'hold_metadata_updated')
        );
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

    before_receipt := rec;
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
      jsonb_build_object(
        'retention_hold', before_receipt.retention_hold,
        'owner_id', before_receipt.retention_hold_owner_id,
        'reason', before_receipt.retention_hold_reason
      ),
      jsonb_build_object(
        'retention_hold', rec.retention_hold,
        'owner_id', rec.retention_hold_owner_id,
        'reason', rec.retention_hold_reason
      ),
      '{}'::jsonb
    );
  else
    if not rec.retention_hold then
      return jsonb_build_object(
        'id', rec.id,
        'retentionHold', rec.retention_hold,
        'deleteAfterAt', rec.delete_after_at
      );
    end if;

    before_receipt := rec;
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
      jsonb_build_object(
        'retention_hold', before_receipt.retention_hold,
        'owner_id', before_receipt.retention_hold_owner_id,
        'reason', before_receipt.retention_hold_reason
      ),
      jsonb_build_object(
        'retention_hold', rec.retention_hold,
        'owner_id', rec.retention_hold_owner_id,
        'reason', rec.retention_hold_reason
      ),
      '{}'::jsonb
    );

    if rec.content_deleted_at is null and rec.delete_after_at is not null then
      retry_at := greatest(rec.delete_after_at, now());

      for before_work in
        select w.*
        from public.work_items w
        where w.receipt_id = p_receipt_id
          and w.kind = 'purge'
          and w.status = 'queued'
          and w.last_error = 'retention_hold'
        for update
      loop
        update public.work_items
        set
          next_attempt_at = retry_at,
          last_error = null,
          terminal_reason = null
        where id = before_work.id
        returning * into after_work;

        perform public.append_audit_event(
          rec.id,
          'work_retried',
          jsonb_build_object(
            'work_id', before_work.id,
            'kind', before_work.kind,
            'status', before_work.status,
            'attempt_count', before_work.attempt_count,
            'next_attempt_at', before_work.next_attempt_at,
            'last_error', before_work.last_error,
            'terminal_reason', before_work.terminal_reason
          ),
          jsonb_build_object(
            'work_id', after_work.id,
            'kind', after_work.kind,
            'status', after_work.status,
            'attempt_count', after_work.attempt_count,
            'next_attempt_at', after_work.next_attempt_at,
            'last_error', after_work.last_error,
            'terminal_reason', after_work.terminal_reason
          ),
          jsonb_build_object('reason', 'retention_hold_cleared')
        );
      end loop;

      for before_work in
        select w.*
        from public.work_items w
        where w.receipt_id = p_receipt_id
          and w.kind = 'purge'
          and w.status = 'dead_letter'
          and w.terminal_reason = 'retention_hold'
        for update
      loop
        update public.work_items
        set
          status = 'queued',
          next_attempt_at = retry_at,
          last_error = null,
          terminal_reason = null,
          lease_owner = null,
          lease_expires_at = null,
          attempt_count = 0
        where id = before_work.id
        returning * into after_work;

        perform public.append_audit_event(
          rec.id,
          'work_retried',
          jsonb_build_object(
            'work_id', before_work.id,
            'kind', before_work.kind,
            'status', before_work.status,
            'attempt_count', before_work.attempt_count,
            'next_attempt_at', before_work.next_attempt_at,
            'last_error', before_work.last_error,
            'terminal_reason', before_work.terminal_reason
          ),
          jsonb_build_object(
            'work_id', after_work.id,
            'kind', after_work.kind,
            'status', after_work.status,
            'attempt_count', after_work.attempt_count,
            'next_attempt_at', after_work.next_attempt_at,
            'last_error', after_work.last_error,
            'terminal_reason', after_work.terminal_reason
          ),
          jsonb_build_object('reason', 'retention_hold_cleared')
        );
      end loop;
    end if;
  end if;

  return jsonb_build_object(
    'id', rec.id,
    'retentionHold', rec.retention_hold,
    'deleteAfterAt', rec.delete_after_at
  );
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

  select * into rec
  from public.receipts
  where id = p_receipt_id
  for update;

  if not found then
    raise exception 'conflict';
  end if;

  if rec.content_deleted_at is not null then
    return jsonb_build_object('id', rec.id, 'contentDeletedAt', rec.content_deleted_at);
  end if;

  if rec.purge_claimed_at is null
    or rec.purge_claimed_by is distinct from p_worker_id then
    raise exception 'conflict';
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
    gps_lat = null,
    gps_lng = null,
    content_deleted_at = now(),
    purge_claimed_at = null,
    purge_claimed_by = null
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

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'receipts',
  'receipts',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp']::text[]
)
on conflict (id) do update
set
  name = excluded.name,
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

revoke all on function public.claim_work(text, integer, integer, text[]) from public, anon, authenticated;
revoke all on function public.defer_work(uuid, text, text) from public, anon, authenticated;
revoke all on function public.assert_purge_eligible(uuid, text) from public, anon, authenticated;
revoke all on function public.set_retention_hold(uuid, uuid, boolean, text, uuid) from public, anon, authenticated;
revoke all on function public.purge_receipt_content(uuid, text) from public, anon, authenticated;

grant execute on function public.claim_work(text, integer, integer, text[]) to service_role;
grant execute on function public.defer_work(uuid, text, text) to service_role;
grant execute on function public.assert_purge_eligible(uuid, text) to service_role;
grant execute on function public.set_retention_hold(uuid, uuid, boolean, text, uuid) to service_role;
grant execute on function public.purge_receipt_content(uuid, text) to service_role;
