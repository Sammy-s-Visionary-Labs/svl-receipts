-- Blocker remediation after RA-2 re-review.
-- Forward-only: do not rewrite 20260814210000_foundation_hardening.sql
-- (already applied live as split MCP names).

-- ---------------------------------------------------------------------------
-- Purge fence and abandoned-upload claim
-- ---------------------------------------------------------------------------

alter table public.receipts
  add column purge_claimed_at timestamptz,
  add column purge_claimed_by text,
  add column cleanup_claimed_at timestamptz;

-- ---------------------------------------------------------------------------
-- Retention clock is write-once
-- ---------------------------------------------------------------------------

create or replace function public.keep_retention_clock()
returns trigger
language plpgsql
as $$
begin
  if old.retention_started_at is not null
    and new.retention_started_at is distinct from old.retention_started_at then
    raise exception 'conflict';
  end if;
  return new;
end;
$$;

drop trigger if exists receipts_keep_retention_clock on public.receipts;
create trigger receipts_keep_retention_clock
  before update on public.receipts
  for each row execute function public.keep_retention_clock();

-- ---------------------------------------------------------------------------
-- Full current-intent export, not any-attachment plus any-job-cost
-- ---------------------------------------------------------------------------

create or replace function public.both_housecall_steps_succeeded(p_receipt_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  intent public.housecall_intents%rowtype;
  job_id text;
  line jsonb;
  line_id uuid;
begin
  select * into intent
  from public.housecall_intents
  where receipt_id = p_receipt_id
  order by created_at desc
  limit 1;

  if not found then
    return false;
  end if;

  if jsonb_typeof(intent.attachment_job_ids) is distinct from 'array'
    or jsonb_array_length(intent.attachment_job_ids) < 1
    or jsonb_typeof(intent.job_cost_lines) is distinct from 'array'
    or jsonb_array_length(intent.job_cost_lines) < 1 then
    return false;
  end if;

  for job_id in select jsonb_array_elements_text(intent.attachment_job_ids)
  loop
    if length(trim(job_id)) = 0 then
      return false;
    end if;
    if not exists (
      select 1
      from public.export_attempts a
      where a.receipt_id = p_receipt_id
        and a.intent_id = intent.id
        and a.step = 'attachment'
        and a.status = 'succeeded'
        and a.housecall_job_id = job_id
    ) then
      return false;
    end if;
  end loop;

  for line in select value from jsonb_array_elements(intent.job_cost_lines)
  loop
    if coalesce(line->>'job_id', '') = '' or coalesce(line->>'receipt_line_id', '') = '' then
      return false;
    end if;
    begin
      line_id := (line->>'receipt_line_id')::uuid;
    exception
      when invalid_text_representation then
        return false;
    end;
    if not exists (
      select 1
      from public.export_attempts a
      where a.receipt_id = p_receipt_id
        and a.intent_id = intent.id
        and a.step = 'job_cost'
        and a.status = 'succeeded'
        and a.housecall_job_id = line->>'job_id'
        and a.receipt_line_id = line_id
    ) then
      return false;
    end if;
  end loop;

  return true;
end;
$$;

create or replace function public.maybe_start_retention(p_receipt_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  rec public.receipts%rowtype;
  start_clock boolean;
begin
  select * into rec
  from public.receipts
  where id = p_receipt_id
  for update;

  if not found or rec.retention_started_at is not null then
    return;
  end if;

  start_clock :=
    rec.status in ('rejected', 'rejected_unreadable', 'duplicate')
    or public.both_housecall_steps_succeeded(p_receipt_id);

  if not start_clock then
    return;
  end if;

  update public.receipts
  set
    retention_started_at = now(),
    delete_after_at = now() + interval '365 days'
  where id = p_receipt_id
    and retention_started_at is null;
end;
$$;

update public.receipts
set
  retention_started_at = coalesce(updated_at, created_at, now()),
  delete_after_at = coalesce(updated_at, created_at, now()) + interval '365 days'
where retention_started_at is null
  and content_deleted_at is null
  and (
    status in ('rejected', 'rejected_unreadable', 'duplicate')
    or public.both_housecall_steps_succeeded(id)
  );

-- ---------------------------------------------------------------------------
-- Approve may SET NULL candidate line ids; job_cost inserts still need a line
-- ---------------------------------------------------------------------------

create or replace function public.reject_mutation()
returns trigger
language plpgsql
as $$
begin
  if current_setting('svl.allow_purge', true) = 'true' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    if tg_op = 'UPDATE' then
      return new;
    end if;
  end if;
  if current_setting('svl.allow_line_rewrite', true) = 'true' and tg_op = 'UPDATE' then
    return new;
  end if;
  raise exception '% is append-only', tg_table_name;
end;
$$;

create or replace function public.require_job_cost_line_id()
returns trigger
language plpgsql
as $$
begin
  if new.step = 'job_cost' and new.receipt_line_id is null then
    raise exception 'invalid_request';
  end if;
  return new;
end;
$$;

drop trigger if exists housecall_links_require_job_cost_line on public.housecall_links;
create trigger housecall_links_require_job_cost_line
  before insert on public.housecall_links
  for each row execute function public.require_job_cost_line_id();

drop trigger if exists export_attempts_require_job_cost_line on public.export_attempts;
create trigger export_attempts_require_job_cost_line
  before insert on public.export_attempts
  for each row execute function public.require_job_cost_line_id();

-- ---------------------------------------------------------------------------
-- Confirm vs abandoned cleanup: claim first
-- ---------------------------------------------------------------------------

create or replace function public.submit_confirmed_receipt(
  p_receipt_id uuid,
  p_actor_id uuid,
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
  perform public.require_active_actor(p_actor_id, null);
  perform set_config('svl.correlation_id', p_correlation_id::text, true);
  perform set_config('svl.actor_id', p_actor_id::text, true);

  select * into rec
  from public.receipts
  where id = p_receipt_id
  for update;

  if not found then
    raise exception 'forbidden';
  end if;

  if rec.owner_user_id is distinct from p_actor_id then
    raise exception 'forbidden';
  end if;

  if rec.status = 'submitted' and rec.checksum is not distinct from p_checksum then
    return jsonb_build_object('id', rec.id, 'status', rec.status);
  end if;

  if rec.status is distinct from 'upload_pending' then
    raise exception 'conflict';
  end if;

  if rec.cleanup_claimed_at is not null then
    raise exception 'conflict';
  end if;

  update public.receipts
  set
    status = 'submitted',
    checksum = p_checksum,
    byte_size = p_byte_size,
    submitted_at = now()
  where id = p_receipt_id
    and status = 'upload_pending'
    and cleanup_claimed_at is null
  returning * into rec;

  if not found then
    raise exception 'conflict';
  end if;

  return jsonb_build_object('id', rec.id, 'status', rec.status);
end;
$$;

create or replace function public.claim_abandoned_upload(p_receipt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  rec public.receipts%rowtype;
begin
  select * into rec
  from public.receipts
  where id = p_receipt_id
  for update;

  if not found or rec.status is distinct from 'upload_pending' then
    raise exception 'conflict';
  end if;

  if rec.created_at > now() - interval '24 hours' then
    raise exception 'conflict';
  end if;

  if rec.cleanup_claimed_at is null then
    update public.receipts
    set cleanup_claimed_at = now()
    where id = p_receipt_id
      and status = 'upload_pending'
      and cleanup_claimed_at is null
    returning * into rec;

    if not found then
      raise exception 'conflict';
    end if;
  end if;

  return jsonb_build_object('id', rec.id, 'storageKey', rec.storage_key);
end;
$$;

create or replace function public.delete_abandoned_upload(p_receipt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  rec public.receipts%rowtype;
begin
  select * into rec
  from public.receipts
  where id = p_receipt_id
  for update;

  if not found
    or rec.status is distinct from 'upload_pending'
    or rec.cleanup_claimed_at is null then
    raise exception 'conflict';
  end if;

  perform set_config('svl.allow_purge', 'true', true);
  delete from public.receipts where id = p_receipt_id and status = 'upload_pending';
  return jsonb_build_object('id', rec.id, 'storageKey', rec.storage_key);
end;
$$;

-- ---------------------------------------------------------------------------
-- Approve: keep line ids so job_candidates SET NULL is not needed on rewrite
-- ---------------------------------------------------------------------------

create or replace function public.approve_receipt_with_outbox(
  p_receipt_id uuid,
  p_actor_id uuid,
  p_lines jsonb,
  p_edits jsonb default null,
  p_correlation_id uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  rec public.receipts%rowtype;
  review_row public.reviews%rowtype;
  intent_row public.housecall_intents%rowtype;
  outbox_row public.housecall_outbox%rowtype;
  work_row public.work_items%rowtype;
  line jsonb;
  ord integer;
  job_ids jsonb;
  job_cost_lines jsonb;
begin
  perform public.require_active_actor(p_actor_id, array['manager', 'admin']);

  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) < 1 then
    raise exception 'invalid_request';
  end if;

  perform set_config('svl.correlation_id', p_correlation_id::text, true);
  perform set_config('svl.actor_id', p_actor_id::text, true);

  select * into rec
  from public.receipts
  where id = p_receipt_id
  for update;

  if not found then
    raise exception 'forbidden';
  end if;

  if rec.status is distinct from 'needs_review' then
    raise exception 'conflict';
  end if;

  ord := 0;
  for line in select value from jsonb_array_elements(p_lines)
  loop
    ord := ord + 1;
    if coalesce(line->>'job_id', '') = ''
      or coalesce(line->>'description', '') = ''
      or line->>'qty' is null
      or line->>'unit_cost_cents' is null then
      raise exception 'invalid_request';
    end if;
  end loop;

  insert into public.reviews (receipt_id, actor_id, decision, reason, edits)
  values (p_receipt_id, p_actor_id, 'approve', null, p_edits)
  returning * into review_row;

  ord := 0;
  for line in select value from jsonb_array_elements(p_lines)
  loop
    ord := ord + 1;
    update public.receipt_lines
    set
      description = line->>'description',
      qty = (line->>'qty')::numeric,
      uom = nullif(line->>'uom', ''),
      unit_cost_cents = (line->>'unit_cost_cents')::integer,
      job_id = line->>'job_id'
    where receipt_id = p_receipt_id
      and sort_index = ord - 1;

    if not found then
      insert into public.receipt_lines (
        receipt_id, sort_index, description, qty, uom, unit_cost_cents, job_id
      ) values (
        p_receipt_id,
        ord - 1,
        line->>'description',
        (line->>'qty')::numeric,
        nullif(line->>'uom', ''),
        (line->>'unit_cost_cents')::integer,
        line->>'job_id'
      );
    end if;
  end loop;

  perform set_config('svl.allow_line_rewrite', 'true', true);
  delete from public.receipt_lines
  where receipt_id = p_receipt_id
    and sort_index >= jsonb_array_length(p_lines);
  perform set_config('svl.allow_line_rewrite', 'false', true);

  select coalesce(
    (
      select jsonb_agg(s.job_id)
      from (
        select distinct l.job_id
        from public.receipt_lines l
        where l.receipt_id = p_receipt_id
      ) s
    ),
    '[]'::jsonb
  )
  into job_ids;

  select coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'job_id', l.job_id,
          'description', l.description,
          'qty', l.qty,
          'unit_cost_cents', l.unit_cost_cents,
          'receipt_line_id', l.id
        )
        order by l.sort_index
      )
      from public.receipt_lines l
      where l.receipt_id = p_receipt_id
    ),
    '[]'::jsonb
  )
  into job_cost_lines;

  insert into public.housecall_intents (
    receipt_id, review_id, payload_version, attachment_job_ids, job_cost_lines
  )
  values (
    p_receipt_id,
    review_row.id,
    1,
    job_ids,
    job_cost_lines
  )
  returning * into intent_row;

  update public.receipts
  set status = 'approved'
  where id = p_receipt_id
    and status = 'needs_review'
  returning * into rec;

  if not found then
    raise exception 'conflict';
  end if;

  insert into public.housecall_outbox (receipt_id, intent_id, status)
  values (p_receipt_id, intent_row.id, 'pending')
  returning * into outbox_row;

  insert into public.work_items (receipt_id, kind, status, next_attempt_at)
  values (p_receipt_id, 'export', 'queued', now())
  on conflict (receipt_id, kind) do update
    set status = excluded.status
  returning * into work_row;

  perform public.append_audit_event(
    p_receipt_id,
    'review_recorded',
    null,
    jsonb_build_object('decision', 'approve', 'review_id', review_row.id),
    '{}'::jsonb
  );
  perform public.append_audit_event(
    p_receipt_id,
    'receipt_approved',
    jsonb_build_object('status', 'needs_review'),
    jsonb_build_object('status', 'approved', 'intent_id', intent_row.id),
    '{}'::jsonb
  );
  perform public.append_audit_event(
    p_receipt_id,
    'outbox_enqueued',
    null,
    jsonb_build_object('outbox_id', outbox_row.id, 'intent_id', intent_row.id),
    '{}'::jsonb
  );

  return jsonb_build_object(
    'id', rec.id,
    'status', rec.status,
    'intentId', intent_row.id,
    'outboxId', outbox_row.id,
    'workId', work_row.id
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Hold vs purge: fence while storage delete is in flight
-- ---------------------------------------------------------------------------

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
  end if;

  return jsonb_build_object(
    'id', rec.id,
    'retentionHold', rec.retention_hold,
    'deleteAfterAt', rec.delete_after_at
  );
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

  if rec.retention_hold or rec.delete_after_at is null or rec.delete_after_at > now() then
    raise exception 'conflict';
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

create or replace function public.release_purge_claim(
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
begin
  select * into rec
  from public.receipts
  where id = p_receipt_id
  for update;

  if not found then
    raise exception 'conflict';
  end if;

  if rec.content_deleted_at is not null then
    raise exception 'conflict';
  end if;

  if rec.purge_claimed_at is null then
    return jsonb_build_object('id', rec.id, 'released', false);
  end if;

  if rec.purge_claimed_by is distinct from p_worker_id then
    raise exception 'conflict';
  end if;

  update public.receipts
  set
    purge_claimed_at = null,
    purge_claimed_by = null
  where id = p_receipt_id
    and purge_claimed_by = p_worker_id
    and content_deleted_at is null
  returning * into rec;

  if not found then
    raise exception 'conflict';
  end if;

  return jsonb_build_object('id', rec.id, 'released', true);
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

  if not found
    or work_row.status is distinct from 'leased'
    or work_row.lease_owner is distinct from p_worker_id then
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
  where r.retention_started_at is not null
    and r.delete_after_at is not null
    and r.delete_after_at <= now()
    and r.retention_hold = false
    and r.content_deleted_at is null
  on conflict (receipt_id, kind) do nothing;

  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants: existing tables plus default privileges for future objects
-- ---------------------------------------------------------------------------

revoke all on table
  public.profiles,
  public.receipts,
  public.extractions,
  public.reviews,
  public.receipt_lines,
  public.job_candidates,
  public.housecall_intents,
  public.housecall_links,
  public.export_attempts,
  public.audit_events,
  public.work_items,
  public.housecall_outbox
from public, anon, authenticated;

grant select on table
  public.profiles,
  public.receipts,
  public.extractions,
  public.reviews,
  public.receipt_lines,
  public.job_candidates,
  public.housecall_intents,
  public.housecall_links,
  public.export_attempts,
  public.audit_events,
  public.work_items,
  public.housecall_outbox
to authenticated, service_role;

grant all on table
  public.profiles,
  public.receipts,
  public.extractions,
  public.reviews,
  public.receipt_lines,
  public.job_candidates,
  public.housecall_intents,
  public.housecall_links,
  public.export_attempts,
  public.audit_events,
  public.work_items,
  public.housecall_outbox
to service_role;

alter default privileges for role postgres in schema public
  revoke all on tables from public, anon, authenticated;

alter default privileges for role postgres in schema public
  revoke all on functions from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_admin') then
    begin
      execute $sql$
        alter default privileges for role supabase_admin in schema public
          revoke all on tables from public, anon, authenticated
      $sql$;
      execute $sql$
        alter default privileges for role supabase_admin in schema public
          revoke all on functions from public, anon, authenticated
      $sql$;
    exception
      when insufficient_privilege then
        null;
    end;
  end if;
end;
$$;

revoke all on function public.keep_retention_clock() from public, anon, authenticated;
revoke all on function public.require_job_cost_line_id() from public, anon, authenticated;
revoke all on function public.claim_abandoned_upload(uuid) from public, anon, authenticated;
revoke all on function public.release_purge_claim(uuid, text) from public, anon, authenticated;
revoke all on function public.submit_confirmed_receipt(uuid, uuid, text, integer, uuid) from public, anon, authenticated;
revoke all on function public.approve_receipt_with_outbox(uuid, uuid, jsonb, jsonb, uuid) from public, anon, authenticated;
revoke all on function public.set_retention_hold(uuid, uuid, boolean, text, uuid) from public, anon, authenticated;
revoke all on function public.delete_abandoned_upload(uuid) from public, anon, authenticated;
revoke all on function public.assert_purge_eligible(uuid, text) from public, anon, authenticated;
revoke all on function public.purge_receipt_content(uuid, text) from public, anon, authenticated;
revoke all on function public.enqueue_due_purges() from public, anon, authenticated;
revoke all on function public.both_housecall_steps_succeeded(uuid) from public, anon, authenticated;
revoke all on function public.maybe_start_retention(uuid) from public, anon, authenticated;

grant execute on function public.keep_retention_clock() to service_role;
grant execute on function public.require_job_cost_line_id() to service_role;
grant execute on function public.claim_abandoned_upload(uuid) to service_role;
grant execute on function public.release_purge_claim(uuid, text) to service_role;
grant execute on function public.submit_confirmed_receipt(uuid, uuid, text, integer, uuid) to service_role;
grant execute on function public.approve_receipt_with_outbox(uuid, uuid, jsonb, jsonb, uuid) to service_role;
grant execute on function public.set_retention_hold(uuid, uuid, boolean, text, uuid) to service_role;
grant execute on function public.delete_abandoned_upload(uuid) to service_role;
grant execute on function public.assert_purge_eligible(uuid, text) to service_role;
grant execute on function public.purge_receipt_content(uuid, text) to service_role;
grant execute on function public.enqueue_due_purges() to service_role;
