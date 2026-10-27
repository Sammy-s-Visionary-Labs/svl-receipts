-- Accept zero quantities in review snapshots. They are explicit exclusions,
-- so only positive-quantity lines create destinations, receipt lines or export steps.
-- Zero unit costs remain valid and are exported unchanged.
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
    jsonb_build_object('vendor',p_snapshot->'vendor','purchase_date',p_snapshot->'purchaseDate','invoice_number',p_snapshot->'invoiceNumber','ticket_number',p_snapshot->'ticketNumber','category',p_snapshot->'category','receipt_total_cents',nullif(p_snapshot->>'referenceTotal','')::numeric*100)) returning id into rev;
  result_status := case p_decision when 'approve' then 'approved' when 'decline' then 'rejected' when 'mark_duplicate' then 'duplicate' else rec.status end;
  if p_decision='approve' then
    for line in select value from jsonb_array_elements(p_snapshot->'lines') loop
      -- Keep zero quantities in the immutable review, never in the provider plan.
      if (line->>'qty')::numeric=0 then continue; end if;
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
