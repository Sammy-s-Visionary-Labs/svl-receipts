-- Foundation hardening after RA-2 review.
-- API-only lifecycle mutations, RA-66 retention start, purge that can commit,
-- abandoned-upload delete, and claim_work kind filter.
-- Extraction/export provider HTTP remains later-epic work.

-- ---------------------------------------------------------------------------
-- Active-profile helpers and owner reads
-- ---------------------------------------------------------------------------

create or replace function public.caller_is_active()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and disabled = false
  )
$$;

create or replace function public.require_active_actor(
  p_actor_id uuid,
  p_allowed_roles text[] default null
)
returns public.profiles
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  prof public.profiles%rowtype;
begin
  if p_actor_id is null then
    raise exception 'unauthenticated';
  end if;

  select * into prof
  from public.profiles
  where id = p_actor_id;

  if not found or prof.disabled then
    raise exception 'unauthenticated';
  end if;

  if p_allowed_roles is not null and prof.role != all (p_allowed_roles) then
    raise exception 'forbidden';
  end if;

  return prof;
end;
$$;

create or replace function public.receipt_visible_to_caller(p_receipt_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.receipts r
    where r.id = p_receipt_id
      and (
        (
          r.owner_user_id = auth.uid()
          and public.caller_is_active()
        )
        or public.current_user_role() in ('manager', 'admin')
      )
  )
$$;

drop policy if exists "receipts_select_owner_or_staff" on public.receipts;
create policy "receipts_select_owner_or_staff"
  on public.receipts
  for select
  to authenticated
  using (
    (
      owner_user_id = auth.uid()
      and public.caller_is_active()
    )
    or public.current_user_role() in ('manager', 'admin')
  );

drop policy if exists "receipts_insert_own" on public.receipts;
drop policy if exists "receipts_update_owner_or_staff" on public.receipts;
drop policy if exists "extractions_insert_via_receipt" on public.extractions;
drop policy if exists "reviews_insert_staff" on public.reviews;
drop policy if exists "receipt_lines_insert_via_receipt" on public.receipt_lines;
drop policy if exists "receipt_lines_update_via_receipt" on public.receipt_lines;
drop policy if exists "job_candidates_insert_via_receipt" on public.job_candidates;
drop policy if exists "housecall_intents_insert_staff" on public.housecall_intents;
drop policy if exists "housecall_links_insert_staff" on public.housecall_links;
drop policy if exists "export_attempts_insert_staff" on public.export_attempts;

-- ---------------------------------------------------------------------------
-- Table grants: reads for authenticated, no Data API mutations
-- ---------------------------------------------------------------------------

revoke insert, update, delete, truncate on table
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

revoke select on table
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
from anon;

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

-- ---------------------------------------------------------------------------
-- RA-66 retention clock
-- ---------------------------------------------------------------------------

alter table public.receipts
  rename column retention_starts_at to retention_started_at;

update public.receipts
set
  retention_started_at = null,
  delete_after_at = null
where content_deleted_at is null;

create or replace function public.both_housecall_steps_succeeded(p_receipt_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    exists (
      select 1
      from public.export_attempts a
      where a.receipt_id = p_receipt_id
        and a.step = 'attachment'
        and a.status = 'succeeded'
    )
    and exists (
      select 1
      from public.export_attempts a
      where a.receipt_id = p_receipt_id
        and a.step = 'job_cost'
        and a.status = 'succeeded'
    )
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
    rec.status in ('rejected', 'rejected_unreadable')
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

create or replace function public.after_receipt_update()
returns trigger
language plpgsql
security definer
set search_path = public
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
    values (new.id, 'extract', 'queued', now())
    on conflict (receipt_id, kind) do nothing;
  end if;

  perform public.maybe_start_retention(new.id);
  return new;
end;
$$;

create or replace function public.after_export_attempt_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.maybe_start_retention(new.receipt_id);
  return new;
end;
$$;

drop trigger if exists export_attempts_maybe_start_retention on public.export_attempts;
create trigger export_attempts_maybe_start_retention
  after insert on public.export_attempts
  for each row execute function public.after_export_attempt_insert();

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
    p_before,
    p_after,
    public.current_correlation_id(),
    coalesce(p_payload, '{}'::jsonb)
  )
  returning id into event_id;
  return event_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Purge: allow generated SET NULL; job_cost rows may lose line ids
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
  raise exception '% is append-only', tg_table_name;
end;
$$;

alter table public.housecall_links
  drop constraint housecall_links_step_line_check;
alter table public.housecall_links
  add constraint housecall_links_step_line_check check (
    (step = 'attachment' and receipt_line_id is null)
    or (step = 'job_cost')
  );

alter table public.export_attempts
  drop constraint export_attempts_step_line_check;
alter table public.export_attempts
  add constraint export_attempts_step_line_check check (
    (step = 'attachment' and receipt_line_id is null)
    or (step = 'job_cost')
  );

-- ---------------------------------------------------------------------------
-- Cross-receipt FK sanity
-- ---------------------------------------------------------------------------

create or replace function public.assert_child_same_receipt()
returns trigger
language plpgsql
as $$
begin
  if tg_table_name = 'job_candidates' and new.receipt_line_id is not null then
    if not exists (
      select 1 from public.receipt_lines l
      where l.id = new.receipt_line_id and l.receipt_id = new.receipt_id
    ) then
      raise exception 'cross-receipt reference';
    end if;
  elsif tg_table_name = 'housecall_intents' and new.review_id is not null then
    if not exists (
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
  end if;
  return new;
end;
$$;

drop trigger if exists job_candidates_same_receipt on public.job_candidates;
create trigger job_candidates_same_receipt
  before insert or update on public.job_candidates
  for each row execute function public.assert_child_same_receipt();

drop trigger if exists housecall_intents_same_receipt on public.housecall_intents;
create trigger housecall_intents_same_receipt
  before insert or update on public.housecall_intents
  for each row execute function public.assert_child_same_receipt();

drop trigger if exists housecall_links_same_receipt on public.housecall_links;
create trigger housecall_links_same_receipt
  before insert or update on public.housecall_links
  for each row execute function public.assert_child_same_receipt();

drop trigger if exists export_attempts_same_receipt on public.export_attempts;
create trigger export_attempts_same_receipt
  before insert or update on public.export_attempts
  for each row execute function public.assert_child_same_receipt();

-- ---------------------------------------------------------------------------
-- Mutation RPCs: service_role only, actor passed by the API
-- ---------------------------------------------------------------------------

drop function if exists public.submit_confirmed_receipt(uuid, text, integer, uuid);
drop function if exists public.approve_receipt_with_outbox(uuid, jsonb, jsonb, uuid);
drop function if exists public.set_retention_hold(uuid, boolean, text, uuid);
drop function if exists public.claim_work(text, integer, integer);

create or replace function public.create_upload_pending_receipt(
  p_actor_id uuid,
  p_receipt_id uuid,
  p_storage_key text,
  p_content_type text,
  p_original_filename text default null,
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
  if p_storage_key is null or length(trim(p_storage_key)) = 0 then
    raise exception 'invalid_request';
  end if;
  if p_content_type is null or p_content_type not in ('image/jpeg', 'image/png', 'image/webp') then
    raise exception 'invalid_request';
  end if;

  perform set_config('svl.correlation_id', p_correlation_id::text, true);
  perform set_config('svl.actor_id', p_actor_id::text, true);

  insert into public.receipts (
    id,
    owner_user_id,
    status,
    storage_key,
    content_type,
    original_filename
  ) values (
    p_receipt_id,
    p_actor_id,
    'upload_pending',
    p_storage_key,
    p_content_type,
    p_original_filename
  )
  returning * into rec;

  return jsonb_build_object('id', rec.id, 'status', rec.status);
end;
$$;

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

  update public.receipts
  set
    status = 'submitted',
    checksum = p_checksum,
    byte_size = p_byte_size,
    submitted_at = now()
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

  delete from public.receipt_lines where receipt_id = p_receipt_id;

  insert into public.receipt_lines (
    receipt_id, sort_index, description, qty, uom, unit_cost_cents, job_id
  )
  select
    p_receipt_id,
    (t.ord - 1),
    t.line->>'description',
    (t.line->>'qty')::numeric,
    nullif(t.line->>'uom', ''),
    (t.line->>'unit_cost_cents')::integer,
    t.line->>'job_id'
  from jsonb_array_elements(p_lines) with ordinality as t(line, ord);

  select coalesce(
    (
      select jsonb_agg(s.job_id)
      from (
        select distinct t.line->>'job_id' as job_id
        from jsonb_array_elements(p_lines) as t(line)
      ) s
    ),
    '[]'::jsonb
  )
  into job_ids;

  insert into public.housecall_intents (
    receipt_id, review_id, payload_version, attachment_job_ids, job_cost_lines
  )
  values (
    p_receipt_id,
    review_row.id,
    1,
    job_ids,
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'job_id', t.line->>'job_id',
            'description', t.line->>'description',
            'qty', (t.line->>'qty')::numeric,
            'unit_cost_cents', (t.line->>'unit_cost_cents')::integer
          )
          order by t.ord
        )
        from jsonb_array_elements(p_lines) with ordinality as t(line, ord)
      ),
      '[]'::jsonb
    )
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
    update public.receipts
    set
      retention_hold = true,
      retention_hold_owner_id = p_actor_id,
      retention_hold_reason = reason
    where id = p_receipt_id
    returning * into rec;
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
    where w.status in ('queued', 'leased')
      and w.kind = any (p_kinds)
      and w.next_attempt_at <= now()
      and (
        w.status = 'queued'
        or w.lease_expires_at is null
        or w.lease_expires_at < now()
      )
    order by w.next_attempt_at asc, w.created_at asc
    for update skip locked
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

  if not found or rec.status is distinct from 'upload_pending' then
    raise exception 'conflict';
  end if;

  perform set_config('svl.allow_purge', 'true', true);
  delete from public.receipts where id = p_receipt_id and status = 'upload_pending';
  return jsonb_build_object('id', rec.id, 'storageKey', rec.storage_key);
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
  on conflict (receipt_id, kind) do update
    set
      status = 'queued',
      next_attempt_at = now(),
      last_error = null,
      terminal_reason = null,
      lease_owner = null,
      lease_expires_at = null
    where public.work_items.status = 'dead_letter';

  get diagnostics inserted = row_count;
  return inserted;
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

  return jsonb_build_object(
    'id', rec.id,
    'storageKey', rec.storage_key,
    'alreadyPurged', false
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

-- ---------------------------------------------------------------------------
-- Execute grants: privileged mutation RPCs are service_role only
-- ---------------------------------------------------------------------------

revoke all on function public.require_active_actor(uuid, text[]) from public, anon, authenticated;
revoke all on function public.maybe_start_retention(uuid) from public, anon, authenticated;
revoke all on function public.both_housecall_steps_succeeded(uuid) from public, anon, authenticated;
revoke all on function public.after_export_attempt_insert() from public, anon, authenticated;
revoke all on function public.assert_child_same_receipt() from public, anon, authenticated;
revoke all on function public.create_upload_pending_receipt(uuid, uuid, text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.submit_confirmed_receipt(uuid, uuid, text, integer, uuid) from public, anon, authenticated;
revoke all on function public.approve_receipt_with_outbox(uuid, uuid, jsonb, jsonb, uuid) from public, anon, authenticated;
revoke all on function public.set_retention_hold(uuid, uuid, boolean, text, uuid) from public, anon, authenticated;
revoke all on function public.claim_work(text, integer, integer, text[]) from public, anon, authenticated;
revoke all on function public.delete_abandoned_upload(uuid) from public, anon, authenticated;
revoke all on function public.assert_purge_eligible(uuid, text) from public, anon, authenticated;
revoke all on function public.purge_receipt_content(uuid, text) from public, anon, authenticated;
revoke all on function public.enqueue_due_purges() from public, anon, authenticated;
revoke all on function public.append_audit_event(uuid, text, jsonb, jsonb, jsonb, text, uuid) from public, anon, authenticated;

grant execute on function public.caller_is_active() to authenticated, service_role;
grant execute on function public.receipt_visible_to_caller(uuid) to authenticated, service_role;
grant execute on function public.current_user_role() to authenticated, service_role;

revoke all on function public.caller_is_active() from public, anon;
revoke all on function public.receipt_visible_to_caller(uuid) from public, anon;
revoke all on function public.current_user_role() from public, anon;
revoke all on function public.handle_new_user() from public, anon, authenticated;

grant execute on function public.create_upload_pending_receipt(uuid, uuid, text, text, text, uuid) to service_role;
grant execute on function public.submit_confirmed_receipt(uuid, uuid, text, integer, uuid) to service_role;
grant execute on function public.approve_receipt_with_outbox(uuid, uuid, jsonb, jsonb, uuid) to service_role;
grant execute on function public.set_retention_hold(uuid, uuid, boolean, text, uuid) to service_role;
grant execute on function public.claim_work(text, integer, integer, text[]) to service_role;
grant execute on function public.delete_abandoned_upload(uuid) to service_role;
grant execute on function public.assert_purge_eligible(uuid, text) to service_role;
grant execute on function public.purge_receipt_content(uuid, text) to service_role;
grant execute on function public.enqueue_due_purges() to service_role;
grant execute on function public.renew_work_lease(uuid, text, integer) to service_role;
grant execute on function public.complete_work(uuid, text) to service_role;
grant execute on function public.fail_work(uuid, text, text, boolean) to service_role;
grant execute on function public.start_queued_work(uuid, text) to service_role;
