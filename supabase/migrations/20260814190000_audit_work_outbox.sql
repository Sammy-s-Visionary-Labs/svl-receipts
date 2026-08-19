-- RA-18: append-only audit events, leased work rows, transactional Housecall outbox.
-- Extraction/export provider HTTP stays out of this migration (later epics).

create or replace function public.current_correlation_id()
returns uuid
language plpgsql
stable
as $$
declare
  raw text;
begin
  raw := nullif(current_setting('svl.correlation_id', true), '');
  if raw is null then
    return gen_random_uuid();
  end if;
  return raw::uuid;
exception
  when invalid_text_representation then
    return gen_random_uuid();
end;
$$;

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references public.receipts (id) on delete cascade,
  actor_id uuid references auth.users (id),
  actor_type text not null,
  action text not null,
  before_ref jsonb,
  after_ref jsonb,
  correlation_id uuid not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint audit_events_actor_type_check check (actor_type in (
    'user',
    'system',
    'worker'
  )),
  constraint audit_events_action_check check (action in (
    'receipt_created',
    'receipt_status_changed',
    'review_recorded',
    'receipt_approved',
    'outbox_enqueued',
    'work_completed',
    'work_retried',
    'work_dead_lettered',
    'external_attempt',
    'retention_hold_set',
    'retention_hold_cleared',
    'content_purged'
  )),
  constraint audit_events_payload_object_check check (jsonb_typeof(payload) = 'object')
);

create index audit_events_receipt_id_created_at_idx
  on public.audit_events (receipt_id, created_at);

create trigger audit_events_append_only
  before update or delete on public.audit_events
  for each row execute function public.reject_mutation();

create table public.work_items (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references public.receipts (id) on delete cascade,
  kind text not null,
  status text not null default 'queued',
  attempt_count integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_owner text,
  lease_expires_at timestamptz,
  last_error text,
  terminal_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint work_items_kind_check check (kind in (
    'extract',
    'export'
  )),
  constraint work_items_status_check check (status in (
    'queued',
    'leased',
    'succeeded',
    'dead_letter'
  )),
  constraint work_items_attempt_count_check check (attempt_count >= 0),
  constraint work_items_receipt_id_kind_key unique (receipt_id, kind)
);

create index work_items_claim_idx
  on public.work_items (next_attempt_at, created_at)
  where status in ('queued', 'leased');

create index work_items_status_idx
  on public.work_items (status, updated_at desc);

create trigger work_items_set_updated_at
  before update on public.work_items
  for each row execute function public.set_updated_at();

create table public.housecall_outbox (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references public.receipts (id) on delete cascade,
  intent_id uuid not null references public.housecall_intents (id),
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint housecall_outbox_receipt_id_key unique (receipt_id),
  constraint housecall_outbox_status_check check (status in (
    'pending',
    'dispatched',
    'cancelled'
  ))
);

create index housecall_outbox_status_created_at_idx
  on public.housecall_outbox (status, created_at);

create trigger housecall_outbox_set_updated_at
  before update on public.housecall_outbox
  for each row execute function public.set_updated_at();

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
begin
  actor_type := coalesce(
    p_actor_type,
    case when auth.uid() is null then 'system' else 'user' end
  );
  actor_id := coalesce(p_actor_id, auth.uid());
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

create or replace function public.audit_receipt_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.append_audit_event(
    new.id,
    'receipt_created',
    null,
    jsonb_build_object('status', new.status),
    '{}'::jsonb
  );
  return new;
end;
$$;

create trigger receipts_audit_insert
  after insert on public.receipts
  for each row execute function public.audit_receipt_insert();

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

  return new;
end;
$$;

create trigger receipts_after_update
  after update on public.receipts
  for each row execute function public.after_receipt_update();

create or replace function public.audit_export_attempt_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.append_audit_event(
    new.receipt_id,
    'external_attempt',
    null,
    jsonb_build_object(
      'step', new.step,
      'status', new.status,
      'external_id', new.external_id
    ),
    jsonb_build_object(
      'housecall_job_id', new.housecall_job_id,
      'error_code', new.error_code
    )
  );
  return new;
end;
$$;

create trigger export_attempts_audit_insert
  after insert on public.export_attempts
  for each row execute function public.audit_export_attempt_insert();

create or replace function public.housecall_outbox_requires_approval()
returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1
    from public.receipts r
    where r.id = new.receipt_id
      and r.status in ('approved', 'exporting', 'exported', 'partial_success')
  ) then
    raise exception 'unapproved receipt cannot enter the export queue';
  end if;
  return new;
end;
$$;

create trigger housecall_outbox_requires_approval
  before insert on public.housecall_outbox
  for each row execute function public.housecall_outbox_requires_approval();

create or replace function public.work_export_requires_outbox()
returns trigger
language plpgsql
as $$
begin
  if new.kind = 'export' then
    if not exists (
      select 1
      from public.receipts r
      where r.id = new.receipt_id
        and r.status in ('approved', 'exporting', 'exported', 'partial_success')
    ) then
      raise exception 'export work requires an approved receipt';
    end if;
    if not exists (
      select 1
      from public.housecall_outbox o
      where o.receipt_id = new.receipt_id
    ) then
      raise exception 'export work requires a housecall outbox row';
    end if;
  end if;
  return new;
end;
$$;

create trigger work_items_export_requires_outbox
  before insert on public.work_items
  for each row execute function public.work_export_requires_outbox();

create or replace function public.require_outbox_on_approved()
returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1
    from public.housecall_outbox o
    where o.receipt_id = new.id
  ) then
    raise exception 'approved receipt requires housecall outbox';
  end if;
  return null;
end;
$$;

create constraint trigger receipts_approved_requires_outbox
  after update on public.receipts
  deferrable initially deferred
  for each row
  when (new.status = 'approved' and old.status is distinct from 'approved')
  execute function public.require_outbox_on_approved();

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

create or replace function public.claim_work(
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 300
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

  return query
  with picked as materialized (
    select w.id
    from public.work_items w
    where w.status in ('queued', 'leased')
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

create or replace function public.renew_work_lease(
  p_work_id uuid,
  p_worker_id text,
  p_lease_seconds integer default 300
)
returns public.work_items
language plpgsql
security definer
set search_path = public
as $$
declare
  rec public.work_items%rowtype;
begin
  update public.work_items
  set lease_expires_at = now() + make_interval(secs => coalesce(p_lease_seconds, 300))
  where id = p_work_id
    and status = 'leased'
    and lease_owner = p_worker_id
  returning * into rec;

  if not found then
    raise exception 'conflict';
  end if;

  return rec;
end;
$$;

create or replace function public.complete_work(
  p_work_id uuid,
  p_worker_id text
)
returns public.work_items
language plpgsql
security definer
set search_path = public
as $$
declare
  rec public.work_items%rowtype;
begin
  update public.work_items
  set
    status = 'succeeded',
    lease_owner = null,
    lease_expires_at = null,
    last_error = null,
    terminal_reason = null
  where id = p_work_id
    and status = 'leased'
    and lease_owner = p_worker_id
  returning * into rec;

  if not found then
    raise exception 'conflict';
  end if;

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
  reason := coalesce(nullif(trim(p_reason), ''), 'worker_failure');

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

create or replace function public.start_queued_work(
  p_work_id uuid,
  p_worker_id text
)
returns public.work_items
language plpgsql
security definer
set search_path = public
as $$
declare
  rec public.work_items%rowtype;
  receipt_status text;
begin
  select * into rec
  from public.work_items
  where id = p_work_id
  for update;

  if not found or rec.status is distinct from 'leased' or rec.lease_owner is distinct from p_worker_id then
    raise exception 'conflict';
  end if;

  perform set_config('svl.correlation_id', public.current_correlation_id()::text, true);

  select r.status into receipt_status
  from public.receipts r
  where r.id = rec.receipt_id
  for update;

  if rec.kind = 'extract' then
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

create or replace function public.approve_receipt_with_outbox(
  p_receipt_id uuid,
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
  if public.current_user_role() not in ('manager', 'admin') then
    raise exception 'forbidden';
  end if;

  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) < 1 then
    raise exception 'invalid_request';
  end if;

  perform set_config('svl.correlation_id', p_correlation_id::text, true);

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
  values (
    p_receipt_id,
    auth.uid(),
    'approve',
    null,
    p_edits
  )
  returning * into review_row;

  delete from public.receipt_lines where receipt_id = p_receipt_id;

  insert into public.receipt_lines (
    receipt_id,
    sort_index,
    description,
    qty,
    uom,
    unit_cost_cents,
    job_id
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
    receipt_id,
    review_id,
    payload_version,
    attachment_job_ids,
    job_cost_lines
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

alter table public.audit_events enable row level security;
alter table public.work_items enable row level security;
alter table public.housecall_outbox enable row level security;

create policy "audit_events_select_via_receipt"
  on public.audit_events
  for select
  to authenticated
  using (public.receipt_visible_to_caller(receipt_id));

create policy "work_items_select_staff"
  on public.work_items
  for select
  to authenticated
  using (public.current_user_role() in ('manager', 'admin'));

create policy "housecall_outbox_select_staff"
  on public.housecall_outbox
  for select
  to authenticated
  using (public.current_user_role() in ('manager', 'admin'));

revoke all on function public.append_audit_event(uuid, text, jsonb, jsonb, jsonb, text, uuid) from public, anon, authenticated;
revoke all on function public.claim_work(text, integer, integer) from public, anon, authenticated;
revoke all on function public.renew_work_lease(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.complete_work(uuid, text) from public, anon, authenticated;
revoke all on function public.fail_work(uuid, text, text, boolean) from public, anon, authenticated;
revoke all on function public.start_queued_work(uuid, text) from public, anon, authenticated;

grant execute on function public.claim_work(text, integer, integer) to service_role;
grant execute on function public.renew_work_lease(uuid, text, integer) to service_role;
grant execute on function public.complete_work(uuid, text) to service_role;
grant execute on function public.fail_work(uuid, text, text, boolean) to service_role;
grant execute on function public.start_queued_work(uuid, text) to service_role;

revoke all on function public.after_receipt_update() from public, anon, authenticated;
revoke all on function public.audit_receipt_insert() from public, anon, authenticated;
revoke all on function public.audit_export_attempt_insert() from public, anon, authenticated;
revoke all on function public.current_correlation_id() from public, anon, authenticated;
revoke all on function public.submit_confirmed_receipt(uuid, text, integer, uuid) from public, anon;
revoke all on function public.approve_receipt_with_outbox(uuid, jsonb, jsonb, uuid) from public, anon;
grant execute on function public.submit_confirmed_receipt(uuid, text, integer, uuid) to authenticated, service_role;
grant execute on function public.approve_receipt_with_outbox(uuid, jsonb, jsonb, uuid) to authenticated, service_role;
