-- Keep old deployments from dispatching a compact-format plan with a legacy request hash.
create schema if not exists private;
revoke all on schema private from public,anon;
grant usage on schema private to service_role;
alter function public.claim_housecall_export_step(uuid,text,integer) set schema private;
create function public.claim_housecall_export_step(p_intent_id uuid,p_worker_id text,p_lease_seconds integer default 120)
returns jsonb language plpgsql security invoker set search_path='' as $$
begin
 if exists(select 1 from public.housecall_export_steps where intent_id=p_intent_id and payload ? 'material_format_version') then return null; end if;
 return private.claim_housecall_export_step(p_intent_id,p_worker_id,p_lease_seconds);
end;$$;
create function public.claim_housecall_export_step_v2(p_intent_id uuid,p_worker_id text,p_lease_seconds integer default 120)
returns jsonb language sql security invoker set search_path='' as $$
 select private.claim_housecall_export_step(p_intent_id,p_worker_id,p_lease_seconds);
$$;
revoke all on function public.claim_housecall_export_step(uuid,text,integer) from public,anon,authenticated;
revoke all on function public.claim_housecall_export_step_v2(uuid,text,integer) from public,anon,authenticated;
grant execute on function public.claim_housecall_export_step(uuid,text,integer) to service_role;
grant execute on function public.claim_housecall_export_step_v2(uuid,text,integer) to service_role;

-- Version the presentation for NEW material steps only. Legacy frozen payloads and hashes remain unchanged.
create or replace function public.plan_housecall_intent() returns trigger language plpgsql security definer set search_path='' as $$
declare job_id text; img jsonb; line jsonb; body jsonb; digest text;
begin
 if new.payload_hash is null then return new; end if;
 for job_id in select distinct jsonb_array_elements_text(new.attachment_job_ids) loop
  for img in select value from jsonb_array_elements(new.approved_images) loop
   body:=jsonb_build_object('intent_id',new.id,'receipt_id',new.receipt_id,'payload_version',new.payload_version,
    'housecall_job_id',job_id,'step','attachment','image',img,'approved_reference',new.approved_reference);
   digest:=public.housecall_payload_hash(body);
   insert into public.housecall_export_steps(intent_id,receipt_id,housecall_job_id,step,receipt_page_id,payload,payload_hash,idempotency_key)
    values(new.id,new.receipt_id,job_id,'attachment',(img->>'page_id')::uuid,body,digest,'ra6:'||digest);
  end loop;
 end loop;
 for line in select value from jsonb_array_elements(new.job_cost_lines) loop
  if not(new.attachment_job_ids ? (line->>'job_id')) or (line->>'qty')::numeric<=0 or
   (line->>'unit_cost_cents')::numeric<0 or (line->>'extended_cost_cents')::numeric<>round((line->>'qty')::numeric*(line->>'unit_cost_cents')::numeric)
   or not exists(select 1 from public.receipt_lines where id=(line->>'receipt_line_id')::uuid and receipt_id=new.receipt_id)
   then raise exception 'invalid_export_plan'; end if;
  body:=jsonb_build_object('intent_id',new.id,'receipt_id',new.receipt_id,'payload_version',new.payload_version,
   'housecall_job_id',line->>'job_id','step','job_cost','line',line,'material_format_version',2,'approved_reference',new.approved_reference);
  digest:=public.housecall_payload_hash(body);
  insert into public.housecall_export_steps(intent_id,receipt_id,housecall_job_id,step,receipt_line_id,payload,payload_hash,idempotency_key)
   values(new.id,new.receipt_id,line->>'job_id','job_cost',(line->>'receipt_line_id')::uuid,body,digest,'ra6:'||digest);
 end loop;
 return new;
end;$$;

-- Include human job numbers in queue labels.
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
      select x.id, x.work_item_id, x.vendor, x.invoice_number, x.ticket_number, x.receipt_total_cents, x.confidence, x.created_at
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
        where review.receipt_id = r.id
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
      -- Latest extraction candidates are ranked by their documented score.
      select j.id, j.housecall_job_id, j.label, j.source from public.job_candidates j
      where j.receipt_id = r.id and j.receipt_line_id is null and j.source_index is null
        and (j.extraction_id = e.id or (e.work_item_id is null and j.extraction_id is null))
      order by j.score desc nulls last, j.created_at desc, j.id desc limit 1
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
    'assignedJobs', coalesce((select jsonb_agg(jsonb_build_object('id',a.job_id,'label',left(j.label,240),'number',j.job_number,'customer',left(j.customer,240)) order by a.job_id) from (select distinct l.job_id from public.receipt_lines l where l.receipt_id=s.id and l.job_id is not null) a left join public.manager_job_catalog j on j.id=a.job_id),'[]'::jsonb),
    'duplicate', case when s.duplicate then 'marked' else 'unmarked' end,
    'suggestedJob', case when s.candidate_id is not null then jsonb_build_object(
      'id', s.housecall_job_id, 'label', coalesce((select j.label from public.manager_job_catalog j where j.id=s.housecall_job_id), left(s.job_label, 240)), 'number',(select j.job_number from public.manager_job_catalog j where j.id=s.housecall_job_id), 'source', left(s.job_source, 80)) end,
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
