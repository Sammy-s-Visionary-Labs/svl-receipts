-- Credit/debit is independent from the existing expense category. Input amounts
-- remain nonnegative magnitudes; approval applies the reviewed direction once.
-- Historical snapshots and frozen payloads retain their original debit meaning.
alter table public.receipt_lines drop constraint receipt_lines_unit_cost_cents_check;
alter table public.receipt_lines add constraint receipt_lines_unit_cost_cents_check
 check (unit_cost_cents between -2147483647 and 2147483647);

create or replace function public.manager_review_command(
  p_receipt_id uuid, p_actor_id uuid, p_version integer, p_extraction_id uuid,
  p_decision text, p_snapshot jsonb, p_reason text default null, p_canonical_id uuid default null
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  rec public.receipts%rowtype; ext uuid; previous jsonb; changes jsonb; rev uuid;
  line jsonb; ord integer := 0; lines jsonb := '[]'; jobs jsonb; intent uuid; result_status text;
  k text; v jsonb; v_qty numeric; v_cost numeric; total numeric := 0; direction integer; receipt_type text;
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
  receipt_type:=coalesce(p_snapshot->>'receiptType','debit');
  if (p_snapshot ? 'receiptType' and jsonb_typeof(p_snapshot->'receiptType') is distinct from 'string') or receipt_type not in ('debit','credit','') or (p_decision='approve' and receipt_type='') then raise exception 'invalid_request_receipt_type'; end if;
  direction:=case when receipt_type='credit' then -1 else 1 end;
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
    if (line->>'qty'<>'' and (line->>'qty' !~ '^\d{1,9}(\.\d{1,3})?$' or (line->>'qty')::numeric<0)) or (line->>'unitCost'<>'' and (line->>'unitCost' !~ '^\d{1,9}(\.\d{1,2})?$' or (line->>'unitCost')::numeric*100>2147483647)) then raise exception 'invalid_request_number'; end if;
    v_qty := nullif(line->>'qty','')::numeric; v_cost := nullif(line->>'unitCost','')::numeric*100;
    if round(v_qty*v_cost)>2147483647 then raise exception 'invalid_request_cost'; end if;
    total := total + coalesce(round(v_qty*v_cost),0);
    if p_decision='approve' then
      if btrim(line->>'description')='' or v_qty is null or v_cost is null or (v_qty>0 and btrim(line->>'jobId')='') then raise exception 'invalid_request_line'; end if;
      if v_qty>0 and not exists(select 1 from public.manager_job_catalog where id=line->>'jobId') and not exists(select 1 from public.job_candidates where receipt_id=rec.id and housecall_job_id=line->>'jobId') then raise exception 'invalid_request_job'; end if;
    end if;
    if line ? 'suggestionId' and not exists(select 1 from public.job_candidates where id=(line->>'suggestionId')::uuid and receipt_id=rec.id) then raise exception 'invalid_request_suggestion'; end if;
  end loop;
  if total>2147483647 then raise exception 'invalid_request_total'; end if;
  if p_decision='approve' and not exists(select 1 from jsonb_array_elements(p_snapshot->'lines') l where (l->>'qty')::numeric>0) then raise exception 'invalid_request_material_required'; end if;
  select snapshot into previous from public.reviews where receipt_id=rec.id and version is not null order by version desc limit 1;
  select coalesce(jsonb_object_agg(key,jsonb_build_object('before',previous->key,'after',value)),'{}') into changes
    from jsonb_each(p_snapshot) where value is distinct from previous->key;
  insert into public.reviews(receipt_id,actor_id,decision,reason,canonical_receipt_id,version,base_version,snapshot,extraction_id,changed_fields,edits)
  values(rec.id,p_actor_id,p_decision,nullif(btrim(p_reason),''),p_canonical_id,rec.review_version+1,rec.review_version,p_snapshot,ext,changes,
    jsonb_build_object('receipt_type',receipt_type,'vendor',p_snapshot->'vendor','purchase_date',p_snapshot->'purchaseDate','invoice_number',p_snapshot->'invoiceNumber','ticket_number',p_snapshot->'ticketNumber','category',p_snapshot->'category','receipt_total_cents',nullif(p_snapshot->>'referenceTotal','')::numeric*100)) returning id into rev;
  result_status := case p_decision when 'approve' then 'approved' when 'decline' then 'rejected' when 'mark_duplicate' then 'duplicate' else rec.status end;
  if p_decision='approve' then
    for line in select value from jsonb_array_elements(p_snapshot->'lines') loop
      -- Keep zero quantities in the immutable review, never in the provider plan.
      if (line->>'qty')::numeric=0 then continue; end if;
      insert into public.receipt_lines(receipt_id,sort_index,description,qty,uom,unit_cost_cents,job_id)
      values(rec.id,ord,line->>'description',(line->>'qty')::numeric,nullif(line->>'uom',''),direction*((line->>'unitCost')::numeric*100)::integer,line->>'jobId')
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

create or replace function public.freeze_housecall_intent() returns trigger language plpgsql security definer set search_path='' as $$
declare rec public.receipts%rowtype; previous public.housecall_intents%rowtype; approved_snapshot jsonb; reference_number text;
begin
 select * into rec from public.receipts where id=new.receipt_id for update;
 if rec.content_deleted_at is not null or rec.purge_claimed_at is not null then raise exception 'conflict'; end if;
 -- Historical RA-2 records lack versioned manager snapshots. They remain
 -- readable but cannot be claimed by the RA-6 live worker.
 if not exists(select 1 from public.reviews where id=new.review_id and receipt_id=new.receipt_id and version is not null and decision='approve') then
  new.payload_hash:=null; new.approved_images:='[]'; new.approved_reference:=''; return new;
 end if;
 select snapshot into approved_snapshot from public.reviews where id=new.review_id;
 reference_number:=coalesce(nullif(btrim(approved_snapshot->>'invoiceNumber'),''),nullif(btrim(approved_snapshot->>'ticketNumber'),''));
 new.approved_reference:=concat_ws(' ',nullif(btrim(approved_snapshot->>'vendor'),''),
  case when reference_number is not null then '#'||reference_number end,nullif(btrim(approved_snapshot->>'purchaseDate'),''));
 if approved_snapshot->>'receiptType'='credit' then new.approved_reference:='CREDIT '||new.approved_reference; end if;
 select * into previous from public.housecall_intents where receipt_id=new.receipt_id order by created_at desc,id desc limit 1;
 if found then
  -- Corrections remain explicit manager commands awaiting reconciliation.
  -- Do not turn them into an additive replay or silently supersede old costs.
  raise exception 'correction_requires_reconciliation';
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('page_id',p.id,'page_index',p.page_index,'storage_key',p.storage_key,
   'content_type',p.content_type,'checksum',p.checksum,'byte_size',p.byte_size) order by p.page_index),'[]') into new.approved_images
 from public.receipt_pages p where p.receipt_id=new.receipt_id and p.confirmed_at is not null;
 -- Missing/partially confirmed image sets can be inspected in dry-run but can
 -- never obtain a write approval or be claimed for export.
 if exists(select 1 from public.receipt_pages where receipt_id=new.receipt_id and confirmed_at is null) then new.approved_images:='[]'; end if;
 new.payload_hash:=public.housecall_payload_hash(jsonb_build_object('id',new.id,'receipt_id',new.receipt_id,
  'review_id',new.review_id,'payload_version',new.payload_version,'attachment_job_ids',new.attachment_job_ids,
  'job_cost_lines',new.job_cost_lines,'approved_images',new.approved_images,'approved_reference',new.approved_reference));
 return new;
end;$$;

create or replace function public.plan_housecall_intent() returns trigger language plpgsql security definer set search_path='' as $$
declare job_id text; img jsonb; line jsonb; body jsonb; digest text; receipt_type text;
begin
 if new.payload_hash is null then return new; end if;
 select coalesce(snapshot->>'receiptType','debit') into receipt_type from public.reviews where id=new.review_id and receipt_id=new.receipt_id;
 if receipt_type not in ('credit','debit') then raise exception 'invalid_export_plan'; end if;
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
   abs((line->>'unit_cost_cents')::numeric)>2147483647 or
   (receipt_type='credit' and (line->>'unit_cost_cents')::numeric>0) or
   (receipt_type='debit' and (line->>'unit_cost_cents')::numeric<0) or (line->>'extended_cost_cents')::numeric<>round((line->>'qty')::numeric*(line->>'unit_cost_cents')::numeric)
   or not exists(select 1 from public.receipt_lines where id=(line->>'receipt_line_id')::uuid and receipt_id=new.receipt_id)
   then raise exception 'invalid_export_plan'; end if;
  body:=jsonb_build_object('intent_id',new.id,'receipt_id',new.receipt_id,'payload_version',new.payload_version,
   'housecall_job_id',line->>'job_id','step','job_cost','line',line,'material_format_version',case when receipt_type='credit' then 3 else 2 end,'receipt_type',receipt_type,'approved_reference',new.approved_reference);
  digest:=public.housecall_payload_hash(body);
  insert into public.housecall_export_steps(intent_id,receipt_id,housecall_job_id,step,receipt_line_id,payload,payload_hash,idempotency_key)
   values(new.id,new.receipt_id,line->>'job_id','job_cost',(line->>'receipt_line_id')::uuid,body,digest,'ra6:'||digest);
 end loop;
 return new;
end;$$;

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
      latest_review.decision as review_decision, coalesce(edits.fields->>'receipt_type',e.normalized->>'receipt_type','debit') as receipt_type,
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
      select x.id, x.work_item_id, x.vendor, x.invoice_number, x.ticket_number, x.receipt_total_cents, x.confidence, x.created_at, x.normalized
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
          and item.key in ('vendor', 'invoice_number', 'ticket_number','receipt_total_cents','receipt_type')
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
    'receiptType', s.receipt_type, 'referenceTotalCents', s.receipt_total_cents, 'extractionId', s.extraction_id,
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

create or replace function public.refresh_receipt_duplicate_candidates(p_receipt_id uuid,p_snapshot jsonb default null)
returns void language plpgsql security invoker set search_path='' as $$
declare candidate record;
begin
 for candidate in
 with latest as (
  select r.id,r.checksum, coalesce(case when r.id=p_receipt_id then p_snapshot->>'receiptType' end,v.snapshot->>'receiptType',e.normalized->>'receipt_type','debit') receipt_type,
   public.normalize_receipt_match_text(coalesce(case when r.id=p_receipt_id then p_snapshot->>'vendor' end,v.snapshot->>'vendor',e.vendor)) vendor,
   coalesce(case when r.id=p_receipt_id then p_snapshot->>'purchaseDate' end,v.snapshot->>'purchaseDate',e.purchase_date) purchase_date,
   coalesce(case when r.id=p_receipt_id then p_snapshot->>'referenceTotal' end,v.snapshot->>'referenceTotal',(e.receipt_total_cents::numeric/100)::text) total,
   replace(public.normalize_receipt_match_text(coalesce(case when r.id=p_receipt_id then p_snapshot->>'invoiceNumber' end,v.snapshot->>'invoiceNumber',e.invoice_number)),' ','') invoice,
   replace(public.normalize_receipt_match_text(coalesce(case when r.id=p_receipt_id then p_snapshot->>'ticketNumber' end,v.snapshot->>'ticketNumber',e.ticket_number)),' ','') ticket
  from public.receipts r
  left join lateral(select * from public.extractions where receipt_id=r.id order by created_at desc,id desc limit 1)e on true
  left join lateral(select * from public.reviews where receipt_id=r.id and snapshot is not null order by version desc nulls last,created_at desc,id desc limit 1)v on true
  where r.submitted_at is not null and r.content_deleted_at is null and r.purge_claimed_at is null and r.status not in ('rejected','rejected_unreadable','duplicate')
 ) select other.id from latest cur join latest other on other.id<>cur.id where cur.id=p_receipt_id and (
  (cur.checksum is not null and cur.checksum=other.checksum)
  or (cur.receipt_type=other.receipt_type and cur.vendor<>'' and cur.vendor=other.vendor and (
   (cur.invoice<>'' and cur.invoice=other.invoice) or (cur.ticket<>'' and cur.ticket=other.ticket)
   or (cur.purchase_date<>'' and cur.purchase_date=other.purchase_date
    and cur.total ~ '^[0-9]+(\.[0-9]{1,2})?$' and other.total ~ '^[0-9]+(\.[0-9]{1,2})?$'
    and case when cur.total ~ '^[0-9]+(\.[0-9]{1,2})?$' and other.total ~ '^[0-9]+(\.[0-9]{1,2})?$' then cur.total::numeric=other.total::numeric else false end
    and not(cur.invoice<>'' and other.invoice<>'' and cur.invoice<>other.invoice)
    and not(cur.ticket<>'' and other.ticket<>'' and cur.ticket<>other.ticket)))))
 loop
  insert into public.duplicate_candidates(receipt_id,candidate_receipt_id,score,reasons,scoring_version)
   values(p_receipt_id,candidate.id,100,'[{"code":"cross_source_match","message":"Matching receipt file, transaction reference, or vendor/date/total. Compare the originals before approval."}]','email-review-v1')
   on conflict(receipt_id,candidate_receipt_id) do nothing;
 end loop;
end;$$;

create or replace function public.receipt_purchase_keys(p_snapshot jsonb,p_checksum text) returns setof text
language sql immutable security invoker set search_path='' as $$
 select encode(sha256(convert_to(k::text,'UTF8')),'hex') from (
  select jsonb_build_array(case when p_snapshot->>'receiptType'='credit' then 'credit_invoice' else 'invoice' end,public.normalize_receipt_match_text(p_snapshot->>'vendor'),replace(public.normalize_receipt_match_text(p_snapshot->>'invoiceNumber'),' ','')) k
  where public.normalize_receipt_match_text(p_snapshot->>'vendor')<>'' and public.normalize_receipt_match_text(p_snapshot->>'invoiceNumber')<>''
  union all
  select jsonb_build_array(case when p_snapshot->>'receiptType'='credit' then 'credit_ticket' else 'ticket' end,public.normalize_receipt_match_text(p_snapshot->>'vendor'),replace(public.normalize_receipt_match_text(p_snapshot->>'ticketNumber'),' ',''))
  where public.normalize_receipt_match_text(p_snapshot->>'vendor')<>'' and public.normalize_receipt_match_text(p_snapshot->>'ticketNumber')<>''
  union all select jsonb_build_array('file',p_checksum) where p_checksum is not null
 ) keys;
$$;

create or replace function public.extraction_duplicate_inputs(p_receipt_id uuid,p_vendor text default null,p_purchase_date text default null,p_total_cents integer default null,p_invoice_number text default null,p_ticket_number text default null,p_total_tolerance_cents integer default 0)
 returns setof jsonb language sql stable security invoker set search_path='' as $$
 with current_pages as (select checksum from public.receipt_pages where receipt_id=p_receipt_id and confirmed_at is not null),
 candidates as (
 select r.id,r.owner_user_id,r.gps_lat,r.gps_lng,r.gps_accuracy_meters,r.content_deleted_at,r.purge_claimed_at,e.vendor,e.purchase_date,e.receipt_total_cents,e.invoice_number,e.ticket_number,coalesce(e.normalized->>'receipt_type','debit') receipt_type,
 case when r.id=p_receipt_id then coalesce((select jsonb_agg(distinct l.job_id) from
  (select prev.id from public.receipts prev where prev.owner_user_id=r.owner_user_id and prev.id<>r.id
   and prev.status in ('approved','exporting','exported','partial_success') and prev.content_deleted_at is null and prev.purge_claimed_at is null
   and prev.submitted_at>=now()-interval '30 days' order by prev.submitted_at desc limit 20) history
  join public.receipt_lines l on l.receipt_id=history.id where l.job_id is not null),'[]') else '[]'::jsonb end uploader_job_ids,
 coalesce((select jsonb_agg(p.checksum order by p.page_index) from public.receipt_pages p where p.receipt_id=r.id and p.confirmed_at is not null),'[]') page_hashes
 from public.receipts r
 left join lateral(select x.* from public.extractions x where x.receipt_id=r.id order by x.created_at desc,x.id desc limit 1)e on true
 where r.content_deleted_at is null and r.purge_claimed_at is null and r.submitted_at is not null
 and exists(select 1 from public.receipts where id=p_receipt_id and content_deleted_at is null and purge_claimed_at is null)
 and (r.id=p_receipt_id or exists(select 1 from public.receipt_pages p where p.receipt_id=r.id and p.checksum in(select checksum from current_pages))
 or (public.normalize_receipt_match_text(p_vendor)<>'' and public.normalize_receipt_match_text(e.vendor)=public.normalize_receipt_match_text(p_vendor) and (e.purchase_date=p_purchase_date or abs(e.receipt_total_cents::bigint-p_total_cents::bigint)<=greatest(0,coalesce(p_total_tolerance_cents,0)) or (nullif(replace(public.normalize_receipt_match_text(e.invoice_number),' ',''),'')=nullif(replace(public.normalize_receipt_match_text(p_invoice_number),' ',''),'')) or (nullif(replace(public.normalize_receipt_match_text(e.ticket_number),' ',''),'')=nullif(replace(public.normalize_receipt_match_text(p_ticket_number),' ',''),'')))))
 order by (r.id=p_receipt_id) desc,
 exists(select 1 from public.receipt_pages p where p.receipt_id=r.id and p.checksum in(select checksum from current_pages)) desc,
 (coalesce((nullif(replace(public.normalize_receipt_match_text(e.invoice_number),' ',''),'')=nullif(replace(public.normalize_receipt_match_text(p_invoice_number),' ',''),'')),false) or coalesce((nullif(replace(public.normalize_receipt_match_text(e.ticket_number),' ',''),'')=nullif(replace(public.normalize_receipt_match_text(p_ticket_number),' ',''),'')),false)) desc,
 r.submitted_at desc,r.id limit 501
 ) select to_jsonb(candidates) from candidates;
$$;
