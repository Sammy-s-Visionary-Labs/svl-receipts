-- RA-2 follow-up: same-receipt trigger must not read missing NEW fields,
-- held purge work must not dead-letter, and audit JSON is redacted in SQL.

-- ---------------------------------------------------------------------------
-- Audit redaction (same keys as packages/domain/src/audit.ts)
-- ---------------------------------------------------------------------------

create or replace function public.redact_audit_json(p_value jsonb)
returns jsonb
language plpgsql
immutable
as $$
declare
  result jsonb := '{}'::jsonb;
  k text;
  v jsonb;
  elem jsonb;
  elems jsonb := '[]'::jsonb;
begin
  if p_value is null then
    return null;
  end if;

  if jsonb_typeof(p_value) = 'array' then
    for elem in select value from jsonb_array_elements(p_value)
    loop
      elems := elems || jsonb_build_array(public.redact_audit_json(elem));
    end loop;
    return elems;
  end if;

  if jsonb_typeof(p_value) is distinct from 'object' then
    return p_value;
  end if;

  for k, v in select key, value from jsonb_each(p_value)
  loop
    if lower(k) in (
      'raw_text',
      'ocr',
      'image',
      'bytes',
      'token',
      'authorization',
      'api_key',
      'secret',
      'password',
      'access_token',
      'refresh_token'
    ) then
      result := result || jsonb_build_object(k, '[redacted]');
    else
      result := result || jsonb_build_object(k, public.redact_audit_json(v));
    end if;
  end loop;

  return result;
end;
$$;

create or replace function public.append_audit_event(
  p_receipt_id uuid,
  p_action text,
  p_before jsonb,
  p_after jsonb,
  p_payload jsonb default '{}'::jsonb,
  p_actor_type text default null,
  p_actor_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  event_id uuid;
  actor_type text;
  actor_id uuid;
  setting_actor text;
begin
  setting_actor := nullif(current_setting('svl.actor_id', true), '');
  begin
    actor_id := coalesce(p_actor_id, setting_actor::uuid, auth.uid());
  exception
    when invalid_text_representation then
      actor_id := coalesce(p_actor_id, auth.uid());
  end;
  actor_type := coalesce(
    p_actor_type,
    case when actor_id is null then 'system' else 'user' end
  );
  insert into public.audit_events (
    receipt_id,
    actor_id,
    actor_type,
    action,
    before_ref,
    after_ref,
    correlation_id,
    payload
  ) values (
    p_receipt_id,
    actor_id,
    actor_type,
    p_action,
    public.redact_audit_json(p_before),
    public.redact_audit_json(p_after),
    public.current_correlation_id(),
    coalesce(public.redact_audit_json(p_payload), '{}'::jsonb)
  )
  returning id into event_id;
  return event_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Nested table guards so NEW.field is only read on the invoking table
-- ---------------------------------------------------------------------------

create or replace function public.assert_child_same_receipt()
returns trigger
language plpgsql
as $$
begin
  if tg_table_name = 'job_candidates' then
    if new.receipt_line_id is not null and not exists (
      select 1 from public.receipt_lines l
      where l.id = new.receipt_line_id and l.receipt_id = new.receipt_id
    ) then
      raise exception 'cross-receipt reference';
    end if;
  elsif tg_table_name = 'housecall_intents' then
    if new.review_id is not null and not exists (
      select 1 from public.reviews r
      where r.id = new.review_id and r.receipt_id = new.receipt_id
    ) then
      raise exception 'cross-receipt reference';
    end if;
  elsif tg_table_name in ('housecall_links', 'export_attempts') then
    if new.receipt_line_id is not null and not exists (
      select 1 from public.receipt_lines l
      where l.id = new.receipt_line_id and l.receipt_id = new.receipt_id
    ) then
      raise exception 'cross-receipt reference';
    end if;
    if new.intent_id is not null and not exists (
      select 1 from public.housecall_intents i
      where i.id = new.intent_id and i.receipt_id = new.receipt_id
    ) then
      raise exception 'cross-receipt reference';
    end if;
  elsif tg_table_name = 'receipt_lines' then
    if new.extraction_id is not null and not exists (
      select 1 from public.extractions e
      where e.id = new.extraction_id and e.receipt_id = new.receipt_id
    ) then
      raise exception 'cross-receipt reference';
    end if;
  elsif tg_table_name = 'housecall_outbox' then
    if not exists (
      select 1 from public.housecall_intents i
      where i.id = new.intent_id and i.receipt_id = new.receipt_id
    ) then
      raise exception 'cross-receipt reference';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists receipt_lines_same_receipt on public.receipt_lines;
create trigger receipt_lines_same_receipt
  before insert or update on public.receipt_lines
  for each row execute function public.assert_child_same_receipt();

drop trigger if exists housecall_outbox_same_receipt on public.housecall_outbox;
create trigger housecall_outbox_same_receipt
  before insert or update on public.housecall_outbox
  for each row execute function public.assert_child_same_receipt();

-- ---------------------------------------------------------------------------
-- Held / not-due purge work is not claimed; hold clear revives this receipt
-- ---------------------------------------------------------------------------

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
begin
  if p_worker_id is null or length(trim(p_worker_id)) = 0 then
    raise exception 'invalid_request';
  end if;
  if p_kinds is null or cardinality(p_kinds) = 0 then
    raise exception 'invalid_request';
  end if;

  return query
  with picked as materialized (
    select w.id
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
  )
  update public.work_items w
  set
    status = 'leased',
    lease_owner = p_worker_id,
    lease_expires_at = now() + make_interval(secs => coalesce(p_lease_seconds, 300)),
    attempt_count = w.attempt_count + 1
  from picked
  where w.id = picked.id
  returning w.*;
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
  reason := coalesce(nullif(trim(p_reason), ''), 'deferred');

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

  return rec;
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
    if rec.purge_claimed_at is not null and rec.content_deleted_at is null then
      raise exception 'conflict';
    end if;
    reason := nullif(trim(p_reason), '');
    if reason is null then
      raise exception 'invalid_request';
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
      status = 'queued',
      next_attempt_at = greatest(coalesce(rec.delete_after_at, now()), now()),
      last_error = null,
      terminal_reason = null,
      lease_owner = null,
      lease_expires_at = null
    where receipt_id = p_receipt_id
      and kind = 'purge'
      and status in ('queued', 'dead_letter')
      and rec.content_deleted_at is null
      and rec.delete_after_at is not null;
  end if;

  return jsonb_build_object(
    'id', rec.id,
    'retentionHold', rec.retention_hold,
    'deleteAfterAt', rec.delete_after_at
  );
end;
$$;

revoke all on function public.redact_audit_json(jsonb) from public, anon, authenticated;
revoke all on function public.append_audit_event(uuid, text, jsonb, jsonb, jsonb, text, uuid) from public, anon, authenticated;
revoke all on function public.assert_child_same_receipt() from public, anon, authenticated;
revoke all on function public.claim_work(text, integer, integer, text[]) from public, anon, authenticated;
revoke all on function public.defer_work(uuid, text, text) from public, anon, authenticated;
revoke all on function public.set_retention_hold(uuid, uuid, boolean, text, uuid) from public, anon, authenticated;

grant execute on function public.claim_work(text, integer, integer, text[]) to service_role;
grant execute on function public.defer_work(uuid, text, text) to service_role;
grant execute on function public.set_retention_hold(uuid, uuid, boolean, text, uuid) to service_role;
grant execute on function public.append_audit_event(uuid, text, jsonb, jsonb, jsonb, text, uuid) to service_role;
