-- RA-4. Reads use RLS; mutations are service-only, actor-checked transactions.
alter table public.receipts add column review_version integer not null default 0 check (review_version >= 0);
alter table public.reviews add column version integer, add column base_version integer,
  add column snapshot jsonb, add column extraction_id uuid references public.extractions(id) on delete set null,
  add column changed_fields jsonb not null default '{}'::jsonb;
create unique index reviews_receipt_version_idx on public.reviews(receipt_id, version) where version is not null;
create table public.manager_job_catalog (
  id text primary key check (length(id) between 1 and 200),
  label text not null, customer text, job_number text, status text,
  scheduled_at timestamptz, technicians jsonb not null default '[]', active boolean not null default true,
  updated_at timestamptz not null default now()
);
alter table public.manager_job_catalog enable row level security;
create policy manager_job_catalog_read on public.manager_job_catalog for select to authenticated
  using (public.current_user_role() in ('manager','admin') and public.caller_is_active());
revoke all on public.manager_job_catalog from public, anon, authenticated;
grant select on public.manager_job_catalog to authenticated;
grant all on public.manager_job_catalog to service_role;
create index manager_job_catalog_active_idx on public.manager_job_catalog(active, scheduled_at, id);

-- Commands awaiting the RA-6 provider/reconciliation handler. These never pretend
-- an external action succeeded. A retry identifies one exact failed attempt.
create table public.manager_recovery_commands (
  id uuid primary key default gen_random_uuid(), receipt_id uuid not null references public.receipts(id) on delete cascade,
  actor_id uuid not null references auth.users(id), intent_id uuid not null references public.housecall_intents(id),
  kind text not null check(kind in ('retry','correction')), attempt_id uuid references public.export_attempts(id),
  reason text not null, before_snapshot jsonb, proposed_snapshot jsonb,
  status text not null default 'pending' check(status in ('pending','processing','completed','cancelled')),
  created_at timestamptz not null default now()
);
create unique index manager_recovery_retry_idx on public.manager_recovery_commands(attempt_id) where kind='retry' and status in ('pending','processing');
create unique index manager_recovery_correction_idx on public.manager_recovery_commands(receipt_id) where kind='correction' and status in ('pending','processing');
alter table public.manager_recovery_commands enable row level security;
create policy manager_recovery_read on public.manager_recovery_commands for select to authenticated
  using (public.current_user_role() in ('manager','admin') and public.caller_is_active());
revoke all on public.manager_recovery_commands from public, anon, authenticated;
grant select on public.manager_recovery_commands to authenticated;
grant all on public.manager_recovery_commands to service_role;

alter table public.receipts add column clarification_reason text;
create or replace function public.clear_manager_content_on_purge() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if new.content_deleted_at is not null and old.content_deleted_at is null then
  new.clarification_reason:=null;
  update public.manager_recovery_commands set reason='Content deleted',before_snapshot=null,proposed_snapshot=null,
    status=case when status in ('pending','processing') then 'cancelled' else status end where receipt_id=new.id;
 end if;
 return new;
end;$$;
revoke all on function public.clear_manager_content_on_purge() from public,anon,authenticated;
create trigger receipts_clear_manager_content before update of content_deleted_at on public.receipts for each row execute function public.clear_manager_content_on_purge();
drop policy manager_recovery_read on public.manager_recovery_commands;
create policy manager_recovery_read on public.manager_recovery_commands for select to authenticated using (
 public.current_user_role() in ('manager','admin') and public.caller_is_active() and exists(select 1 from public.receipts r where r.id=receipt_id and r.content_deleted_at is null and r.purge_claimed_at is null));

create or replace function public.manager_review_command(
  p_receipt_id uuid, p_actor_id uuid, p_version integer, p_extraction_id uuid,
  p_decision text, p_snapshot jsonb, p_reason text default null, p_canonical_id uuid default null
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  rec public.receipts%rowtype; ext uuid; previous jsonb; changes jsonb; rev uuid;
  line jsonb; ord integer := 0; lines jsonb := '[]'; jobs jsonb; intent uuid; result_status text;
  k text; v jsonb; v_qty numeric; v_cost numeric; total numeric := 0;
begin
  perform public.require_active_actor(p_actor_id, array['manager','admin']);
  perform set_config('svl.actor_id',p_actor_id::text,true);
  perform set_config('svl.correlation_id',gen_random_uuid()::text,true);
  if p_decision='mark_duplicate' then
    perform id from public.receipts where id in (p_receipt_id,p_canonical_id) order by id for update;
  end if;
  select * into rec from public.receipts where id=p_receipt_id for update;
  if not found then raise exception 'forbidden'; end if;
  if rec.content_deleted_at is not null or rec.purge_claimed_at is not null or rec.status <> 'needs_review' then raise exception 'conflict'; end if;
  select id into ext from public.extractions where receipt_id=rec.id order by created_at desc,id desc limit 1;
  if p_version is null or p_version <> rec.review_version or p_extraction_id is distinct from ext then raise exception 'conflict_stale_review'; end if;
  if p_decision not in ('save_draft','request_clarification','decline','mark_duplicate','approve') or p_decision is null then raise exception 'invalid_request'; end if;
  if p_decision in ('request_clarification','decline','mark_duplicate') and (length(btrim(coalesce(p_reason,''))) not between 1 and 2000) then raise exception 'invalid_request_reason'; end if;
  if p_decision='mark_duplicate' then
    if p_canonical_id is null or p_canonical_id=rec.id or not exists(select 1 from public.receipts where id=p_canonical_id and submitted_at is not null and content_deleted_at is null and status not in ('upload_pending','duplicate','rejected','rejected_unreadable')) then raise exception 'invalid_request_canonical'; end if;
  elsif p_canonical_id is not null then raise exception 'invalid_request_canonical'; end if;
  if jsonb_typeof(p_snapshot) is distinct from 'object' or octet_length(p_snapshot::text)>128000 or jsonb_typeof(p_snapshot->'lines') is distinct from 'array' then raise exception 'invalid_request_snapshot'; end if;
  if jsonb_array_length(p_snapshot->'lines')>100 then raise exception 'invalid_request_lines'; end if;
  foreach k in array array['vendor','purchaseDate','invoiceNumber','ticketNumber','category','referenceTotal','managerNotes'] loop
    if jsonb_typeof(p_snapshot->k) is distinct from 'string' or length(p_snapshot->>k)>2000 then raise exception 'invalid_request_fields'; end if;
  end loop;
  if p_snapshot->>'purchaseDate'<>'' then
    if p_snapshot->>'purchaseDate' !~ '^\d{4}-\d{2}-\d{2}$' or to_char((p_snapshot->>'purchaseDate')::date,'YYYY-MM-DD')<>p_snapshot->>'purchaseDate' then raise exception 'invalid_request_date'; end if;
  end if;
  if p_snapshot->>'referenceTotal'<>'' and (p_snapshot->>'referenceTotal' !~ '^\d{1,9}(\.\d{1,2})?$' or (p_snapshot->>'referenceTotal')::numeric*100>2147483647) then raise exception 'invalid_request_total'; end if;
  if p_decision='approve' and (btrim(p_snapshot->>'vendor')='' or btrim(p_snapshot->>'purchaseDate')='' or btrim(p_snapshot->>'category')='' or jsonb_array_length(p_snapshot->'lines')=0) then raise exception 'invalid_request_required'; end if;
  for line in select value from jsonb_array_elements(p_snapshot->'lines') loop
    foreach k in array array['description','qty','uom','unitCost','jobId'] loop
      if jsonb_typeof(line->k) is distinct from 'string' or length(line->>k)>500 then raise exception 'invalid_request_line'; end if;
    end loop;
    if (line->>'qty'<>'' and (line->>'qty' !~ '^\d{1,9}(\.\d{1,3})?$' or (line->>'qty')::numeric<=0)) or (line->>'unitCost'<>'' and (line->>'unitCost' !~ '^\d{1,9}(\.\d{1,2})?$' or (line->>'unitCost')::numeric*100>2147483647)) then raise exception 'invalid_request_number'; end if;
    v_qty := nullif(line->>'qty','')::numeric; v_cost := nullif(line->>'unitCost','')::numeric*100;
    if round(v_qty*v_cost)>2147483647 then raise exception 'invalid_request_cost'; end if;
    total := total + coalesce(round(v_qty*v_cost),0);
    if p_decision='approve' then
      if btrim(line->>'description')='' or v_qty is null or v_cost is null or btrim(line->>'jobId')='' then raise exception 'invalid_request_line'; end if;
      if not exists(select 1 from public.manager_job_catalog where id=line->>'jobId') and not exists(select 1 from public.job_candidates where receipt_id=rec.id and housecall_job_id=line->>'jobId') then raise exception 'invalid_request_job'; end if;
    end if;
    if line ? 'suggestionId' and not exists(select 1 from public.job_candidates where id=(line->>'suggestionId')::uuid and receipt_id=rec.id) then raise exception 'invalid_request_suggestion'; end if;
  end loop;
  if total>2147483647 then raise exception 'invalid_request_total'; end if;
  select snapshot into previous from public.reviews where receipt_id=rec.id and version is not null order by version desc limit 1;
  select coalesce(jsonb_object_agg(key,jsonb_build_object('before',previous->key,'after',value)),'{}') into changes
    from jsonb_each(p_snapshot) where value is distinct from previous->key;
  insert into public.reviews(receipt_id,actor_id,decision,reason,canonical_receipt_id,version,base_version,snapshot,extraction_id,changed_fields,edits)
  values(rec.id,p_actor_id,p_decision,nullif(btrim(p_reason),''),p_canonical_id,rec.review_version+1,rec.review_version,p_snapshot,ext,changes,
    jsonb_build_object('vendor',p_snapshot->'vendor','purchase_date',p_snapshot->'purchaseDate','invoice_number',p_snapshot->'invoiceNumber','ticket_number',p_snapshot->'ticketNumber','category',p_snapshot->'category','receipt_total_cents',nullif(p_snapshot->>'referenceTotal','')::numeric*100)) returning id into rev;
  result_status := case p_decision when 'approve' then 'approved' when 'decline' then 'rejected' when 'mark_duplicate' then 'duplicate' else rec.status end;
  if p_decision='approve' then
    for line in select value from jsonb_array_elements(p_snapshot->'lines') loop
      insert into public.receipt_lines(receipt_id,sort_index,description,qty,uom,unit_cost_cents,job_id)
      values(rec.id,ord,line->>'description',(line->>'qty')::numeric,nullif(line->>'uom',''),((line->>'unitCost')::numeric*100)::integer,line->>'jobId')
      on conflict(receipt_id,sort_index) do update set description=excluded.description,qty=excluded.qty,uom=excluded.uom,unit_cost_cents=excluded.unit_cost_cents,job_id=excluded.job_id;
      ord := ord+1;
    end loop;
    perform set_config('svl.allow_line_rewrite','true',true);
    delete from public.receipt_lines where receipt_id=rec.id and sort_index>=ord;
    perform set_config('svl.allow_line_rewrite','false',true);
    select jsonb_agg(jsonb_build_object('receipt_line_id',id,'job_id',job_id,'description',description,'qty',qty,'unit_cost_cents',unit_cost_cents,'extended_cost_cents',round(qty*unit_cost_cents)) order by sort_index) into lines from public.receipt_lines where receipt_id=rec.id;
    select jsonb_agg(distinct value->'job_id') into jobs from jsonb_array_elements(lines);
    insert into public.housecall_intents(receipt_id,review_id,payload_version,attachment_job_ids,job_cost_lines) values(rec.id,rev,1,jobs,lines) returning id into intent;
    update public.receipts set status=result_status,review_version=review_version+1,clarification_reason=case when p_decision='request_clarification' then btrim(p_reason) else null end where id=rec.id;
    insert into public.housecall_outbox(receipt_id,intent_id,status) values(rec.id,intent,'pending');
    insert into public.work_items(receipt_id,kind,status) values(rec.id,'export','queued');
    perform public.append_audit_event(rec.id,'receipt_approved',jsonb_build_object('status',rec.status),jsonb_build_object('status',result_status,'intent_id',intent),'{}');
    perform public.append_audit_event(rec.id,'outbox_enqueued',null,jsonb_build_object('intent_id',intent),'{}');
  else
    update public.receipts set status=result_status,review_version=review_version+1,clarification_reason=case when p_decision='request_clarification' then btrim(p_reason) else null end where id=rec.id;
  end if;
  perform public.append_audit_event(rec.id,'review_recorded',jsonb_build_object('version',rec.review_version),jsonb_build_object('version',rec.review_version+1,'decision',p_decision,'review_id',rev),'{}');
  return jsonb_build_object('id',rec.id,'version',rec.review_version+1,'status',result_status,'intentId',intent);
end; $$;
revoke all on function public.manager_review_command(uuid,uuid,integer,uuid,text,jsonb,text,uuid) from public,anon,authenticated;
grant execute on function public.manager_review_command(uuid,uuid,integer,uuid,text,jsonb,text,uuid) to service_role;

create or replace function public.manager_recovery_command(p_receipt_id uuid,p_actor_id uuid,p_intent_id uuid,p_kind text,p_attempt_id uuid,p_reason text,p_snapshot jsonb default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare rec public.receipts%rowtype; attempt public.export_attempts%rowtype; command uuid; existing uuid; previous jsonb;
begin
  perform public.require_active_actor(p_actor_id,case when p_kind='correction' then array['admin'] else array['manager','admin'] end);
  perform set_config('svl.actor_id',p_actor_id::text,true);
  perform set_config('svl.correlation_id',gen_random_uuid()::text,true);
  select * into rec from public.receipts where id=p_receipt_id for update;
  if not found then raise exception 'forbidden'; end if;
  if rec.content_deleted_at is not null or rec.purge_claimed_at is not null or rec.status not in ('approved','exporting','exported','partial_success','failed') or not exists(select 1 from public.housecall_outbox where receipt_id=rec.id and intent_id=p_intent_id and status<>'cancelled') then raise exception 'conflict'; end if;
  if length(btrim(coalesce(p_reason,''))) not between 1 and 2000 then raise exception 'invalid_request_reason'; end if;
  if p_kind='retry' then
    select * into attempt from public.export_attempts where id=p_attempt_id and receipt_id=rec.id and intent_id=p_intent_id;
    if not found or attempt.status not in ('retryable_failure','permanent_failure') then raise exception 'conflict'; end if;
    if not exists(select 1 from public.housecall_intents i where i.id=p_intent_id and ((attempt.step='attachment' and i.attachment_job_ids ? attempt.housecall_job_id) or (attempt.step='job_cost' and exists(select 1 from jsonb_array_elements(i.job_cost_lines) l where l->>'job_id'=attempt.housecall_job_id and l->>'receipt_line_id'=attempt.receipt_line_id::text)))) then raise exception 'conflict'; end if;
    if exists(select 1 from public.export_attempts a where a.receipt_id=rec.id and a.intent_id=p_intent_id and a.step=attempt.step and a.housecall_job_id=attempt.housecall_job_id and a.receipt_line_id is not distinct from attempt.receipt_line_id and (a.status='succeeded' or (a.created_at,a.id)>(attempt.created_at,attempt.id))) or exists(select 1 from public.housecall_links l where l.receipt_id=rec.id and l.step=attempt.step and l.housecall_job_id=attempt.housecall_job_id and l.receipt_line_id is not distinct from attempt.receipt_line_id) then raise exception 'conflict'; end if;
    if exists(select 1 from public.manager_recovery_commands where receipt_id=rec.id and kind='correction' and status in ('pending','processing')) then raise exception 'conflict'; end if;
    select id into existing from public.manager_recovery_commands where attempt_id=p_attempt_id and status in ('pending','processing');
    if existing is not null then return jsonb_build_object('id',existing,'status','pending'); end if;
  elsif p_kind='correction' then
    if p_attempt_id is not null or jsonb_typeof(p_snapshot) is distinct from 'object' or jsonb_typeof(p_snapshot->'lines') is distinct from 'array' or octet_length(p_snapshot::text)>128000 then raise exception 'invalid_request'; end if;
    if exists(select 1 from public.manager_recovery_commands where receipt_id=rec.id and status in ('pending','processing')) or exists(select 1 from public.work_items where receipt_id=rec.id and kind='export' and status='leased' and lease_expires_at>now()) then raise exception 'conflict'; end if;
    select r.snapshot into previous from public.housecall_intents i join public.reviews r on r.id=i.review_id where i.id=p_intent_id;
    if previous is not distinct from p_snapshot then raise exception 'invalid_request_no_changes'; end if;
  else raise exception 'invalid_request'; end if;
  insert into public.manager_recovery_commands(receipt_id,actor_id,intent_id,kind,attempt_id,reason,before_snapshot,proposed_snapshot)
    values(rec.id,p_actor_id,p_intent_id,p_kind,p_attempt_id,btrim(p_reason),previous,p_snapshot) returning id into command;
  perform public.append_audit_event(rec.id,case when p_kind='retry' then 'work_retried' else 'review_recorded' end,null,jsonb_build_object('command_id',command,'intent_id',p_intent_id),jsonb_build_object('decision',p_kind,'attempt_id',p_attempt_id));
  return jsonb_build_object('id',command,'status','pending');
end; $$;
revoke all on function public.manager_recovery_command(uuid,uuid,uuid,text,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.manager_recovery_command(uuid,uuid,uuid,text,uuid,text,jsonb) to service_role;
create or replace function public.manager_search_jobs(p_search text default '',p_active boolean default true,p_limit integer default 50)
returns setof public.manager_job_catalog language plpgsql stable security invoker set search_path='' as $$
begin
 if public.current_user_role() not in ('manager','admin') or not public.caller_is_active() then raise exception 'forbidden'; end if;
 if length(p_search)>120 or p_limit not between 1 and 50 then raise exception 'invalid_request'; end if;
 return query select * from public.manager_job_catalog j where (not p_active or j.active) and (p_search='' or strpos(lower(concat_ws(' ',j.id,j.label,j.customer,j.job_number)),lower(p_search))>0) order by j.scheduled_at desc nulls last,j.id limit p_limit;
end; $$;
revoke all on function public.manager_search_jobs(text,boolean,integer) from public,anon,authenticated;
grant execute on function public.manager_search_jobs(text,boolean,integer) to authenticated;
create or replace function public.manager_current_export_attempts(p_receipt_id uuid,p_intent_id uuid)
returns setof public.export_attempts language plpgsql stable security invoker set search_path='' as $$
begin
 if public.current_user_role() not in ('manager','admin') or not public.caller_is_active() then raise exception 'forbidden'; end if;
 return query select distinct on(a.housecall_job_id,a.step,a.receipt_line_id) a.* from public.export_attempts a
 where a.receipt_id=p_receipt_id and a.intent_id=p_intent_id
 order by a.housecall_job_id,a.step,a.receipt_line_id,(a.status='succeeded') desc,a.created_at desc,a.id desc limit 200;
end; $$;
revoke all on function public.manager_current_export_attempts(uuid,uuid) from public,anon,authenticated;
grant execute on function public.manager_current_export_attempts(uuid,uuid) to authenticated;
create or replace function public.manager_receipt_timeline(p_receipt_id uuid,p_after_at timestamptz default null,p_after_id uuid default null,p_limit integer default 51)
returns setof jsonb language plpgsql stable security invoker set search_path='' as $$
begin
 if public.current_user_role() not in ('manager','admin') or not public.caller_is_active() then raise exception 'forbidden'; end if;
 if p_limit not between 1 and 51 or (p_after_at is null)<>(p_after_id is null) then raise exception 'invalid_request'; end if;
 if not exists(select 1 from public.receipts where id=p_receipt_id and content_deleted_at is null and purge_claimed_at is null) then raise exception 'forbidden'; end if;
 return query with events as (
 (select id,created_at,action,coalesce(actor_id::text,actor_type) actor,null::integer version,null::text reason,'{}'::jsonb changes,null::text external_id from public.audit_events where receipt_id=p_receipt_id and (p_after_at is null or (created_at,id)>(p_after_at,p_after_id)) order by created_at,id limit p_limit)
 union all
 (select id,created_at,decision,actor_id::text,version,reason,changed_fields,null from public.reviews where receipt_id=p_receipt_id and (p_after_at is null or (created_at,id)>(p_after_at,p_after_id)) order by created_at,id limit p_limit)
 union all
 (select id,created_at,'extraction_recorded','Extraction service',schema_version,null,'{}'::jsonb,null from public.extractions where receipt_id=p_receipt_id and (p_after_at is null or (created_at,id)>(p_after_at,p_after_id)) order by created_at,id limit p_limit)
 union all
 (select id,created_at,'export_'||step||'_'||status,'Export service',payload_version,case when error_code in ('timeout','rate_limited','unauthenticated','invalid_request','provider_unavailable','connection_failed') then error_code when error_code is not null then 'Export requires administrator review' else null end,'{}'::jsonb,external_id from public.export_attempts where receipt_id=p_receipt_id and (p_after_at is null or (created_at,id)>(p_after_at,p_after_id)) order by created_at,id limit p_limit)
 union all
 (select id,created_at,kind||'_'||status,actor_id::text,null,reason,case when kind='correction' then jsonb_build_object('correction',jsonb_build_object('before',before_snapshot,'after',proposed_snapshot)) else '{}'::jsonb end,null from public.manager_recovery_commands where receipt_id=p_receipt_id and (p_after_at is null or (created_at,id)>(p_after_at,p_after_id)) order by created_at,id limit p_limit)
 ) select jsonb_build_object('id',e.id,'createdAt',to_char(e.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'action',e.action,'actor',e.actor,'version',e.version,'reason',e.reason,'changes',e.changes,'externalId',e.external_id) from events e order by e.created_at,e.id limit p_limit;
end; $$;
revoke all on function public.manager_receipt_timeline(uuid,timestamptz,uuid,integer) from public,anon,authenticated;
grant execute on function public.manager_receipt_timeline(uuid,timestamptz,uuid,integer) to authenticated;
create index manager_recovery_receipt_time_idx on public.manager_recovery_commands(receipt_id,created_at,id);

create or replace function public.manager_review_queue(
  p_tab text default 'needs-review', p_sort text default 'oldest',
  p_status text default 'all', p_age text default 'all', p_submitter uuid default null,
  p_vendor text default '', p_confidence text default 'all', p_duplicate text default 'all',
  p_housecall text default 'all', p_search text default '', p_from date default null,
  p_to date default null, p_limit integer default 26, p_as_of timestamptz default now(),
  p_cursor_at timestamptz default null, p_cursor_id uuid default null
)
returns setof jsonb
language plpgsql stable security invoker
set search_path = ''
-- Keep parameter-specific plans so CASE sort directions fold to the indexed
-- submitted_at/id order even after repeated calls on a pooled connection.
set plan_cache_mode = 'force_custom_plan'
as $$
declare
  statuses text[];
begin
  if auth.uid() is null or coalesce(public.current_user_role(), '') not in ('manager', 'admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_tab is null or p_tab not in ('needs-review', 'processing', 'partial-success', 'failed', 'completed', 'rejected-duplicate', 'history')
    or p_sort is null or p_sort not in ('oldest', 'newest')
    or p_status is null or p_status not in ('all', 'submitted', 'processing', 'needs_review', 'approved', 'exporting', 'exported', 'partial_success', 'failed', 'rejected', 'rejected_unreadable', 'duplicate')
    or p_age is null or p_age not in ('all', 'over-24h', 'over-7d', 'over-30d')
    or p_confidence is null or p_confidence not in ('all', 'low', 'high', 'unknown')
    or p_duplicate is null or p_duplicate not in ('all', 'marked', 'unmarked')
    or p_housecall is null or p_housecall not in ('all', 'not_started', 'pending', 'in_progress', 'partial_success', 'succeeded', 'failed', 'cancelled')
    or p_vendor is null or length(p_vendor) > 120 or p_search is null or length(p_search) > 120
    or p_limit is null or p_limit < 1 or p_limit > 51
    or p_as_of is null or not isfinite(p_as_of)
    or (p_cursor_at is null) <> (p_cursor_id is null)
    or (p_cursor_at is not null and not isfinite(p_cursor_at))
    or (p_from is not null and not isfinite(p_from)) or (p_to is not null and not isfinite(p_to))
    or (p_from is not null and p_to is not null and p_from > p_to)
  then
    raise exception 'invalid_queue_parameters' using errcode = '22023';
  end if;
  statuses := case p_tab
    when 'needs-review' then array['needs_review']
    when 'processing' then array['submitted', 'processing', 'approved', 'exporting']
    when 'partial-success' then array['partial_success']
    when 'failed' then array['failed']
    when 'completed' then array['exported']
    when 'history' then array['approved','exporting','exported','partial_success','failed','rejected','rejected_unreadable','duplicate']
    when 'rejected-duplicate' then array['rejected', 'rejected_unreadable', 'duplicate'] end;

  return query
  with candidates as (
    select r.* from public.receipts r
    where r.status = any(statuses) and r.submitted_at is not null and r.content_deleted_at is null and r.purge_claimed_at is null
      and (p_status = 'all' or r.status = p_status)
      and (p_submitter is null or r.owner_user_id = p_submitter)
      and (p_from is null or r.submitted_at >= p_from::timestamp at time zone 'UTC')
      and (p_to is null or r.submitted_at < (p_to + 1)::timestamp at time zone 'UTC')
      and (p_age = 'all' or r.submitted_at <= p_as_of - case p_age
        when 'over-24h' then interval '24 hours' when 'over-7d' then interval '7 days' else interval '30 days' end)
      and (p_cursor_at is null or
        (p_sort = 'oldest' and (r.submitted_at, r.id) > (p_cursor_at, p_cursor_id)) or
        (p_sort = 'newest' and (r.submitted_at, r.id) < (p_cursor_at, p_cursor_id)))
  ), summaries as (
    select r.id, r.owner_user_id, r.status, r.submitted_at,
      e.id as extraction_id, coalesce((edits.fields->>'receipt_total_cents')::numeric,e.receipt_total_cents) as receipt_total_cents, confidence.minimum as confidence,
      case when edits.fields ? 'vendor' then edits.fields ->> 'vendor' else e.vendor end as vendor,
      coalesce(case when edits.fields ? 'invoice_number' then edits.fields ->> 'invoice_number' else e.invoice_number end,
        case when edits.fields ? 'ticket_number' then edits.fields ->> 'ticket_number' else e.ticket_number end) as reference,
      latest_review.decision as review_decision,
      (r.status = 'duplicate' or latest_review.decision = 'mark_duplicate') is true as duplicate,
      job.id as candidate_id, job.housecall_job_id, job.label as job_label, job.source as job_source,
      pages.page_count, pages.has_thumbnail,
      case
        when r.status = 'exported' then 'succeeded'
        when r.status = 'partial_success' then 'partial_success'
        when outbox.status = 'cancelled' then 'cancelled'
        when intent.id is null then 'not_started'
        when attempts.has_failure and attempts.has_success then 'partial_success'
        when attempts.has_failure then 'failed'
        when attempts.has_active or r.status = 'exporting' then 'in_progress'
        -- Individual successful steps alone cannot prove the whole intent completed.
        else 'pending' end as housecall_status
    from candidates r
    left join lateral (
      select x.id, x.vendor, x.invoice_number, x.ticket_number, x.receipt_total_cents, x.confidence, x.created_at
      from public.extractions x where x.receipt_id = r.id order by x.created_at desc, x.id desc limit 1
    ) e on true
    left join lateral (
      select min(case when jsonb_typeof(value) = 'number' then
        case when (value::text)::numeric between 0 and 1 then (value::text)::numeric end end) as minimum
      from jsonb_each(coalesce(e.confidence, '{}'::jsonb))
    ) confidence on true
    left join lateral (
      -- Reviews are sparse patches. Keep the newest valid edit for each displayed
      -- field since the current extraction, including explicit clears.
      select jsonb_object_agg(field.key, field.value) as fields from (
        select distinct on (item.key) item.key, item.value
        from public.reviews review
        cross join lateral jsonb_each(case when jsonb_typeof(review.edits) = 'object' then review.edits else '{}'::jsonb end) item
        where review.receipt_id = r.id and (e.created_at is null or review.created_at >= e.created_at)
          and item.key in ('vendor', 'invoice_number', 'ticket_number','receipt_total_cents')
          and ((item.key <> 'receipt_total_cents' and jsonb_typeof(item.value) in ('string','null')) or (item.key='receipt_total_cents' and jsonb_typeof(item.value)='number'))
        order by item.key, review.created_at desc, review.id desc
      ) field
    ) edits on true
    left join lateral (
      select review.decision from public.reviews review where review.receipt_id = r.id
      order by review.created_at desc, review.id desc limit 1
    ) latest_review on true
    left join lateral (
      -- No score/rank exists in the stored candidate schema. Expose only the
      -- latest document-level candidate, and do not infer a match confidence.
      select j.id, j.housecall_job_id, j.label, j.source from public.job_candidates j
      where j.receipt_id = r.id and j.receipt_line_id is null
      order by j.created_at desc, j.id desc limit 1
    ) job on true
    left join lateral (
      select count(*)::integer as page_count, coalesce(bool_or(page.page_index = 0 and page.confirmed_at is not null), false) as has_thumbnail
      from public.receipt_pages page where page.receipt_id = r.id and page.confirmed_at is not null
    ) pages on true
    left join public.housecall_outbox outbox on outbox.receipt_id = r.id
    left join lateral (
      -- The outbox identifies the current intent. Unqueued later snapshots must
      -- not replace its export state; use latest only when there is no outbox.
      select i.id from public.housecall_intents i where i.receipt_id = r.id
        and (outbox.intent_id is null or i.id = outbox.intent_id)
      order by i.created_at desc, i.id desc limit 1
    ) intent on true
    left join lateral (
      select bool_or(current.status in ('retryable_failure', 'permanent_failure')) as has_failure,
        bool_or(current.status in ('succeeded', 'skipped')) as has_success,
        bool_or(current.status in ('pending', 'in_progress')) as has_active
      from (
        select distinct on (a.housecall_job_id, a.step, a.receipt_line_id) a.status
        from public.export_attempts a where a.receipt_id = r.id and a.intent_id = intent.id
        order by a.housecall_job_id, a.step, a.receipt_line_id, a.created_at desc, a.id desc
      ) current
    ) attempts on true
  )
  select jsonb_build_object(
    'id', s.id, 'submitterId', s.owner_user_id, 'status', s.status,
    'submittedAt', to_char(s.submitted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'vendor', left(s.vendor, 240), 'reference', left(s.reference, 160),
    'referenceTotalCents', s.receipt_total_cents, 'extractionId', s.extraction_id,
    'latestReviewDecision', s.review_decision, 'confidence', s.confidence,
    'assignedJobs', coalesce((select jsonb_agg(jsonb_build_object('id',a.job_id,'label',left(j.label,240)) order by a.job_id) from (select distinct l.job_id from public.receipt_lines l where l.receipt_id=s.id and l.job_id is not null) a left join public.manager_job_catalog j on j.id=a.job_id),'[]'::jsonb),
    'duplicate', case when s.duplicate then 'marked' else 'unmarked' end,
    'suggestedJob', case when s.candidate_id is not null then jsonb_build_object(
      'id', s.housecall_job_id, 'label', left(s.job_label, 240), 'source', left(s.job_source, 80)) end,
    'pageCount', s.page_count, 'hasThumbnail', s.has_thumbnail, 'housecallStatus', s.housecall_status,
    'warnings', to_jsonb(array_remove(array[
      case when s.extraction_id is null then 'Extraction pending' end,
      case when s.confidence is null then 'Confidence unavailable' end,
      case when s.confidence < 0.8 then 'Low extraction confidence' end,
      case when s.candidate_id is null then 'No job suggestion' end,
      case when s.duplicate then 'Marked duplicate' end,
      case when s.status = 'rejected_unreadable' then 'Image unreadable' end,
      case when s.status = 'failed' then 'Processing failed' end,
      case when s.housecall_status in ('failed', 'partial_success') then 'Housecall export needs attention' end
    ], null))
  )
  from summaries s
  where (p_vendor = '' or strpos(lower(coalesce(s.vendor, '')), lower(p_vendor)) > 0)
    and (p_search = '' or strpos(lower(concat_ws(' ', s.id::text, s.vendor, s.reference, s.housecall_job_id, s.job_label, s.owner_user_id::text,s.review_decision,s.housecall_status)), lower(p_search)) > 0
      or exists (select 1 from public.housecall_links l where l.receipt_id=s.id and (l.external_id=p_search or l.housecall_job_id=p_search))
      or exists (select 1 from public.export_attempts a where a.receipt_id=s.id and a.external_id=p_search)
      or exists (select 1 from public.receipt_lines l left join public.manager_job_catalog j on j.id=l.job_id where l.receipt_id=s.id and strpos(lower(concat_ws(' ',l.job_id,j.job_number,j.customer,j.label)),lower(p_search))>0))
    and (p_confidence = 'all' or (p_confidence = 'unknown' and s.confidence is null)
      or (p_confidence = 'low' and s.confidence < 0.8) or (p_confidence = 'high' and s.confidence >= 0.8))
    and (p_duplicate = 'all' or (p_duplicate = 'marked' and s.duplicate) or (p_duplicate = 'unmarked' and not s.duplicate))
    and (p_housecall = 'all' or s.housecall_status = p_housecall)
  order by case when p_sort = 'oldest' then s.submitted_at end asc,
    case when p_sort = 'newest' then s.submitted_at end desc,
    case when p_sort = 'oldest' then s.id end asc,
    case when p_sort = 'newest' then s.id end desc
  limit p_limit;
end;
$$;
revoke all on function public.manager_review_queue(text, text, text, text, uuid, text, text, text, text, text, date, date, integer, timestamptz, timestamptz, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.manager_review_queue(text, text, text, text, uuid, text, text, text, text, text, date, date, integer, timestamptz, timestamptz, uuid)
  to authenticated;
grant execute on function public.require_active_actor(uuid,text[]) to service_role;
-- Preserve earlier sparse review edits when reopening pre-RA-4 receipts.
create or replace function public.manager_legacy_review_edits(p_receipt_id uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result jsonb;
begin
 if coalesce(public.current_user_role(),'') not in ('manager','admin') or not public.caller_is_active() then raise exception 'forbidden';end if;
 if not exists(select 1 from public.receipts where id=p_receipt_id and content_deleted_at is null and purge_claimed_at is null) then raise exception 'forbidden';end if;
 select coalesce(jsonb_object_agg(field.key,field.value),'{}') into result from (
  select distinct on(item.key) item.key,item.value from public.reviews r
  cross join lateral jsonb_each(case when jsonb_typeof(r.edits)='object' then r.edits else '{}'::jsonb end) item
  where r.receipt_id=p_receipt_id and item.key in ('vendor','purchase_date','invoice_number','ticket_number','category','receipt_total_cents','manager_notes','lines')
  order by item.key,r.created_at desc,r.id desc
 ) field;return result;
end;$$;
revoke all on function public.manager_legacy_review_edits(uuid) from public,anon,authenticated;
grant execute on function public.manager_legacy_review_edits(uuid) to authenticated;
