-- RA-5: leased extraction generations, restricted evidence and manager-authoritative intelligence.
alter table public.work_items add column generation integer not null default 1 check(generation > 0);
alter table public.extractions
 add column work_item_id uuid references public.work_items(id),
 add column generation integer,
 add column model text,
 add column prompt_version text,
 add column normalized jsonb not null default '{}',
 add column warnings jsonb not null default '[]',
 add column usage jsonb not null default '{}',
 add constraint extraction_normalized_object check(jsonb_typeof(normalized)='object'),
 add constraint extraction_warnings_array check(jsonb_typeof(warnings)='array');
-- Multiple generations in a single transaction still have a deterministic latest result.
alter table public.extractions alter column created_at set default clock_timestamp();
create unique index extraction_work_generation_idx on public.extractions(work_item_id,generation) where work_item_id is not null;
create index extraction_duplicate_identifiers_idx on public.extractions(lower(vendor),purchase_date,receipt_total_cents);
create index receipt_pages_checksum_idx on public.receipt_pages(checksum) where checksum is not null;

create schema if not exists receipt_private;
revoke all on schema receipt_private from public,anon,authenticated;
grant usage on schema receipt_private to service_role;
create table receipt_private.extraction_evidence (
 extraction_id uuid primary key references public.extractions(id) on delete cascade,
 receipt_id uuid not null references public.receipts(id) on delete cascade,
 raw_text text not null,
 field_evidence jsonb not null default '[]',
 original_observation jsonb not null default '{}',
 created_at timestamptz not null default now()
);
create index extraction_evidence_receipt_idx on receipt_private.extraction_evidence(receipt_id);
alter table receipt_private.extraction_evidence enable row level security;
revoke all on receipt_private.extraction_evidence from public,anon,authenticated;
grant all on receipt_private.extraction_evidence to service_role;
create trigger extraction_evidence_immutable before update or delete on receipt_private.extraction_evidence
 for each row execute function public.reject_mutation();

create table public.receipt_categories (
 id text primary key check(id ~ '^[A-Za-z0-9_-]{1,100}$'), label text not null check(length(btrim(label)) between 1 and 100),
 active boolean not null default true, keywords jsonb not null default '[]' check(jsonb_typeof(keywords)='array'),
 version integer not null default 1 check(version>0), approved_by uuid references auth.users(id), updated_at timestamptz not null default now()
);
alter table public.receipt_categories enable row level security;
create policy receipt_categories_staff_read on public.receipt_categories for select to authenticated
 using(public.current_user_role() in ('manager','admin') and public.caller_is_active());
revoke all on public.receipt_categories from public,anon,authenticated;
grant select on public.receipt_categories to authenticated;
grant all on public.receipt_categories to service_role;

alter table public.manager_job_catalog add column po_references jsonb not null default '[]',
 add column service_address text, add column lat double precision, add column lng double precision,
 add column assigned_worker_ids jsonb not null default '[]', add column vendor_history jsonb not null default '[]',
 add constraint manager_job_coordinates check((lat is null and lng is null) or (lat between -90 and 90 and lng between -180 and 180));
alter table public.job_candidates add column extraction_id uuid references public.extractions(id) on delete cascade,
 add column score numeric check(score >= 0), add column reasons jsonb not null default '[]',
 add column scoring_version text, add column source_index integer check(source_index >= 0);
create index job_candidates_extraction_idx on public.job_candidates(extraction_id,score desc);

create table public.duplicate_candidates (
 id uuid primary key default gen_random_uuid(), receipt_id uuid not null references public.receipts(id) on delete cascade,
 candidate_receipt_id uuid not null references public.receipts(id) on delete cascade,
 extraction_id uuid references public.extractions(id) on delete cascade,
 score numeric not null check(score between 0 and 100), reasons jsonb not null default '[]' check(jsonb_typeof(reasons)='array'),
 scoring_version text not null, status text not null default 'pending' check(status in ('pending','dismissed','confirmed')),
 decided_by uuid references auth.users(id), decided_at timestamptz, created_at timestamptz not null default now(),
 check(receipt_id<>candidate_receipt_id), unique(receipt_id,candidate_receipt_id)
);
create index duplicate_candidate_target_idx on public.duplicate_candidates(candidate_receipt_id);
alter table public.duplicate_candidates enable row level security;
create policy duplicate_candidates_staff_read on public.duplicate_candidates for select to authenticated using(
 public.current_user_role() in ('manager','admin') and public.caller_is_active()
 and exists(select 1 from public.receipts r where r.id=receipt_id and r.content_deleted_at is null and r.purge_claimed_at is null)
 and exists(select 1 from public.receipts r where r.id=candidate_receipt_id and r.content_deleted_at is null and r.purge_claimed_at is null));
revoke all on public.duplicate_candidates from public,anon,authenticated;
grant select on public.duplicate_candidates to authenticated;
grant all on public.duplicate_candidates to service_role;

create table public.receipt_intelligence_feedback (
 id uuid primary key default gen_random_uuid(), receipt_id uuid not null references public.receipts(id) on delete cascade,
 review_id uuid not null references public.reviews(id) on delete cascade, extraction_id uuid references public.extractions(id) on delete cascade,
 actor_id uuid not null references auth.users(id), field_path text not null,
 suggested_value jsonb, final_value jsonb, accepted boolean not null,
 model text, prompt_version text, scoring_version text, created_at timestamptz not null default now(),
 unique(review_id,field_path)
);
create index receipt_feedback_receipt_idx on public.receipt_intelligence_feedback(receipt_id,created_at desc);
create index receipt_feedback_extraction_idx on public.receipt_intelligence_feedback(extraction_id);
alter table public.receipt_intelligence_feedback enable row level security;
create policy receipt_feedback_staff_read on public.receipt_intelligence_feedback for select to authenticated using(
 public.current_user_role() in ('manager','admin') and public.caller_is_active()
 and exists(select 1 from public.receipts r where r.id=receipt_id and r.content_deleted_at is null and r.purge_claimed_at is null));
revoke all on public.receipt_intelligence_feedback from public,anon,authenticated;
grant select on public.receipt_intelligence_feedback to authenticated;
grant all on public.receipt_intelligence_feedback to service_role;
create trigger receipt_feedback_immutable before update or delete on public.receipt_intelligence_feedback for each row execute function public.reject_mutation();

create function public.configure_receipt_category(p_actor_id uuid,p_id text,p_label text,p_active boolean,p_keywords jsonb default '[]')
 returns jsonb language plpgsql security invoker set search_path='' as $$
declare result public.receipt_categories%rowtype;
begin
 perform public.require_active_actor(p_actor_id,array['admin']);
 -- Serialize configuration writes so the bounded catalog cannot race its cap.
 perform pg_advisory_xact_lock(550041);
 if not exists(select 1 from public.receipt_categories where id=p_id) and (select count(*) from public.receipt_categories)>=500 then raise exception 'invalid_request_category_limit'; end if;
 if p_id is null or p_id !~ '^[A-Za-z0-9_-]{1,100}$' or p_label is null or length(btrim(p_label)) not between 1 and 100 or p_active is null
 or jsonb_typeof(p_keywords) is distinct from 'array' or jsonb_array_length(p_keywords)>100
 or exists(select 1 from jsonb_array_elements(p_keywords) v where jsonb_typeof(v)<>'string' or length(v#>>'{}')>100) then raise exception 'invalid_request'; end if;
 insert into public.receipt_categories(id,label,active,keywords,approved_by) values(p_id,btrim(p_label),p_active,p_keywords,p_actor_id)
 on conflict(id) do update set label=excluded.label,active=excluded.active,keywords=excluded.keywords,approved_by=excluded.approved_by,version=public.receipt_categories.version+1,updated_at=now() returning * into result;
 return to_jsonb(result);
end;$$;

create function public.dismiss_duplicate_candidate(p_id uuid,p_actor_id uuid) returns jsonb language plpgsql security invoker set search_path='' as $$
declare item public.duplicate_candidates%rowtype;
begin
 perform public.require_active_actor(p_actor_id,array['manager','admin']);
 select * into item from public.duplicate_candidates where id=p_id for update;
 if not found then raise exception 'forbidden'; end if;
 if item.status='confirmed' or not exists(select 1 from public.receipts where id=item.receipt_id and status='needs_review' and content_deleted_at is null and purge_claimed_at is null) then raise exception 'conflict'; end if;
 update public.duplicate_candidates set status='dismissed',decided_by=p_actor_id,decided_at=now() where id=p_id;
 return jsonb_build_object('id',p_id,'status','dismissed');
end;$$;

create function public.request_receipt_reextraction(p_receipt_id uuid,p_actor_id uuid) returns jsonb language plpgsql security invoker set search_path='' as $$
declare rec public.receipts%rowtype; item public.work_items%rowtype;
begin
 perform public.require_active_actor(p_actor_id,array['manager','admin']);
 select * into item from public.work_items where receipt_id=p_receipt_id and kind='extract' for update;
 if not found or item.status in ('queued','leased') then raise exception 'conflict'; end if;
 select * into rec from public.receipts where id=p_receipt_id for update;
 if not found or rec.content_deleted_at is not null or rec.purge_claimed_at is not null then raise exception 'forbidden'; end if;
 if rec.status not in ('needs_review','failed') or not exists(select 1 from public.readability_checks where receipt_id=rec.id and readable) then raise exception 'conflict'; end if;
 update public.work_items set status='queued',generation=generation+1,attempt_count=0,next_attempt_at=now(),lease_owner=null,lease_expires_at=null,last_error=null,terminal_reason=null where id=item.id returning * into item;
 return jsonb_build_object('workId',item.id,'generation',item.generation);
end;$$;

-- Result and its projection are one lease-checked transaction. Incomplete lines stay
-- in immutable normalized evidence; only valid cost lines enter receipt_lines.
create function public.record_extraction_result(p_work_id uuid,p_worker_id text,p_generation integer,p_result jsonb,p_model text,p_prompt_version text,p_usage jsonb default '{}',p_intelligence jsonb default '{}')
 returns jsonb language plpgsql security invoker set search_path='' as $$
declare item public.work_items%rowtype; rec public.receipts%rowtype; existing uuid; result_id uuid;
 line jsonb; candidate jsonb; ord integer; normalized jsonb; cat jsonb;
begin
 select * into item from public.work_items where id=p_work_id for update;
 if not found or item.kind<>'extract' or item.status<>'leased' or item.lease_owner is distinct from p_worker_id or item.lease_expires_at<=now() or item.generation is distinct from p_generation then raise exception 'conflict'; end if;
 select id into existing from public.extractions where work_item_id=item.id and generation=item.generation;
 if found then return jsonb_build_object('id',existing,'receiptId',item.receipt_id,'replayed',true); end if;
 select * into rec from public.receipts where id=item.receipt_id for update;
 if not found or rec.status not in ('processing','needs_review','failed') or rec.content_deleted_at is not null or rec.purge_claimed_at is not null then raise exception 'conflict'; end if;
 if not exists(select 1 from public.readability_checks where receipt_id=rec.id and readable) then raise exception 'conflict'; end if;
 if jsonb_typeof(p_result) is distinct from 'object' or p_result->>'schema_version' is distinct from '1' or p_result->>'provider' is distinct from 'gemini'
 or jsonb_typeof(p_result->'lines') is distinct from 'array' or jsonb_array_length(p_result->'lines')>100
 or jsonb_typeof(p_result->'confidence') is distinct from 'object' or jsonb_typeof(p_result->'warnings') is distinct from 'array'
 or jsonb_typeof(p_result->'evidence') is distinct from 'array' or octet_length(p_result::text)>1000000
 or length(coalesce(p_model,'')) not between 1 and 160 or length(coalesce(p_prompt_version,'')) not between 1 and 100
 then raise exception 'invalid_request'; end if;
 -- Store OCR text and verbatim field snippets only in a schema outside the Data API.
 normalized := p_result-'raw_text'-'evidence'-'original_observation';
 cat:=p_intelligence->'categorySuggestion';
 if cat->>'categoryId' is not null and exists(select 1 from public.receipt_categories where id=cat->>'categoryId' and active) then
  normalized:=normalized||jsonb_build_object('category_suggestion',cat);
 end if;
 insert into public.extractions(receipt_id,work_item_id,generation,schema_version,provider,model,prompt_version,vendor,purchase_date,invoice_number,ticket_number,receipt_total_cents,tax_cents,lines,confidence,raw_text,normalized,warnings,usage)
 values(rec.id,item.id,item.generation,1,'gemini',p_model,p_prompt_version,p_result->>'vendor',p_result->>'purchase_date',p_result->>'invoice_number',p_result->>'ticket_number',(p_result->>'receipt_total_cents')::integer,(p_result->>'tax_cents')::integer,p_result->'lines',p_result->'confidence',null,normalized,p_result->'warnings',p_usage) returning id into result_id;
 insert into receipt_private.extraction_evidence(extraction_id,receipt_id,raw_text,field_evidence,original_observation) values(result_id,rec.id,coalesce(p_result->>'raw_text',''),p_result->'evidence',coalesce(p_result->'original_observation','{}'));
 if rec.review_version=0 and not exists(select 1 from public.reviews where receipt_id=rec.id) then
  perform set_config('svl.allow_line_rewrite','true',true);
  delete from public.receipt_lines where receipt_id=rec.id;
  perform set_config('svl.allow_line_rewrite','false',true);
  for line,ord in select value,(ordinality-1)::integer from jsonb_array_elements(p_result->'lines') with ordinality loop
   if nullif(btrim(line->>'description'),'') is not null and (line->>'qty')::numeric>0 and (line->>'unit_cost_cents')::numeric>=0
    and (line->>'qty')::numeric=round((line->>'qty')::numeric,3) and round((line->>'qty')::numeric*(line->>'unit_cost_cents')::numeric)<=2147483647 then
    insert into public.receipt_lines(receipt_id,extraction_id,sort_index,description,qty,uom,unit_cost_cents)
    values(rec.id,result_id,ord,line->>'description',(line->>'qty')::numeric,line->>'uom',(line->>'unit_cost_cents')::integer);
   end if;
  end loop;
 end if;
 for candidate in select value from jsonb_array_elements(coalesce(p_intelligence->'jobCandidates','[]')) loop
  if exists(select 1 from public.manager_job_catalog where id=candidate->>'jobId') then
   insert into public.job_candidates(receipt_id,extraction_id,housecall_job_id,label,source,score,reasons,scoring_version,source_index)
   values(rec.id,result_id,candidate->>'jobId',candidate->>'label','receipt_intelligence',(candidate->>'score')::numeric,coalesce(candidate->'reasons','[]'),candidate->>'scoringVersion',(candidate->>'sourceIndex')::integer);
  end if;
 end loop;
 for candidate in select value from jsonb_array_elements(coalesce(p_intelligence->'duplicateCandidates','[]')) loop
  if (candidate->>'receiptId')::uuid<>rec.id and exists(select 1 from public.receipts where id=(candidate->>'receiptId')::uuid and content_deleted_at is null and purge_claimed_at is null and submitted_at is not null) then
   insert into public.duplicate_candidates(receipt_id,candidate_receipt_id,extraction_id,score,reasons,scoring_version)
   values(rec.id,(candidate->>'receiptId')::uuid,result_id,(candidate->>'score')::numeric,coalesce(candidate->'reasons','[]'),candidate->>'scoringVersion') on conflict(receipt_id,candidate_receipt_id) do nothing;
  end if;
 end loop;
 update public.receipts set status='needs_review' where id=rec.id and status in ('processing','failed');
 return jsonb_build_object('id',result_id,'receiptId',rec.id,'replayed',false);
end;$$;

-- Only a manager-facing service route calls this; it returns candidate summaries,
-- excludes deleted/purging documents, and never exposes image keys or OCR text.
create function public.normalize_receipt_match_text(p_value text) returns text language sql immutable set search_path='' as $$
 select btrim(regexp_replace(lower(normalize(coalesce(p_value,''),NFKC)),'[^[:alnum:]]+',' ','g'));
$$;
revoke all on function public.normalize_receipt_match_text(text) from public,anon,authenticated;
grant execute on function public.normalize_receipt_match_text(text) to service_role;
create index extraction_normalized_vendor_idx on public.extractions(public.normalize_receipt_match_text(vendor),purchase_date);

create function public.extraction_duplicate_inputs(p_receipt_id uuid,p_vendor text default null,p_purchase_date text default null,p_total_cents integer default null,p_invoice_number text default null,p_ticket_number text default null,p_total_tolerance_cents integer default 0)
 returns setof jsonb language sql stable security invoker set search_path='' as $$
 with current_pages as (select checksum from public.receipt_pages where receipt_id=p_receipt_id and confirmed_at is not null),
 candidates as (
 select r.id,r.owner_user_id,r.gps_lat,r.gps_lng,r.gps_accuracy_meters,r.content_deleted_at,r.purge_claimed_at,e.vendor,e.purchase_date,e.receipt_total_cents,e.invoice_number,e.ticket_number,
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

create table public.duplicate_candidate_decisions (
 id uuid primary key default gen_random_uuid(), candidate_id uuid not null references public.duplicate_candidates(id) on delete cascade,
 actor_id uuid not null references auth.users(id), status text not null check(status in ('dismissed','confirmed')), created_at timestamptz not null default now()
);
create index duplicate_decision_candidate_idx on public.duplicate_candidate_decisions(candidate_id,created_at);
alter table public.duplicate_candidate_decisions enable row level security;
create policy duplicate_decisions_staff_read on public.duplicate_candidate_decisions for select to authenticated using(
 public.current_user_role() in ('manager','admin') and public.caller_is_active() and exists(select 1 from public.duplicate_candidates c where c.id=candidate_id));
revoke all on public.duplicate_candidate_decisions from public,anon,authenticated;
grant select on public.duplicate_candidate_decisions to authenticated;
grant all on public.duplicate_candidate_decisions to service_role;
create trigger duplicate_decisions_immutable before update or delete on public.duplicate_candidate_decisions for each row execute function public.reject_mutation();
create function public.capture_duplicate_decision() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if new.status in ('dismissed','confirmed') and new.status is distinct from old.status then
  insert into public.duplicate_candidate_decisions(candidate_id,actor_id,status) values(new.id,new.decided_by,new.status);
 end if;
 return new;
end;$$;
create trigger duplicate_candidate_decision_record after update of status on public.duplicate_candidates for each row execute function public.capture_duplicate_decision();

create function public.validate_intelligence_review() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if new.decision='approve' and new.snapshot is not null and not exists(select 1 from public.receipt_categories where id=new.snapshot->>'category' and active) then
  raise exception 'invalid_request_category';
 end if;
 if new.decision='mark_duplicate' then
  -- Keep every duplicate one hop from a canonical receipt. Do not turn a
  -- canonical document already referenced by others into a duplicate chain.
  if exists(select 1 from public.reviews where canonical_receipt_id=new.receipt_id and decision='mark_duplicate')
   or exists(select 1 from public.housecall_intents where receipt_id=new.receipt_id)
   or exists(select 1 from public.receipts where id=new.canonical_receipt_id and (status='duplicate' or purge_claimed_at is not null or content_deleted_at is not null)) then raise exception 'invalid_request_canonical'; end if;
 end if;
 return new;
end;$$;
create trigger reviews_validate_intelligence before insert on public.reviews for each row execute function public.validate_intelligence_review();

create function public.capture_intelligence_feedback() returns trigger language plpgsql security invoker set search_path='' as $$
declare ext public.extractions%rowtype; source_ext public.extractions%rowtype; job_ext public.extractions%rowtype; field text; original jsonb; final jsonb; suggested jsonb;
 line jsonb; orig_line jsonb; idx integer; source_idx integer; suggestion public.job_candidates%rowtype; scoring text;
begin
 if new.snapshot is null then return new; end if;
 select * into ext from public.extractions where id=new.extraction_id;
 original:=jsonb_build_object('vendor',coalesce(ext.vendor,''),'purchaseDate',coalesce(ext.purchase_date,''),'invoiceNumber',coalesce(ext.invoice_number,''),'ticketNumber',coalesce(ext.ticket_number,''),
 'referenceTotal',case when ext.receipt_total_cents is null then '' else to_char(ext.receipt_total_cents::numeric/100,'FM9999999990.00') end,
 'category',coalesce(ext.normalized->'category_suggestion'->>'categoryId',''));
 foreach field in array array['vendor','purchaseDate','invoiceNumber','ticketNumber','referenceTotal','category'] loop
  suggested:=original->field; final:=new.snapshot->field;
  insert into public.receipt_intelligence_feedback(receipt_id,review_id,extraction_id,actor_id,field_path,suggested_value,final_value,accepted,model,prompt_version,scoring_version)
  values(new.receipt_id,new.id,new.extraction_id,new.actor_id,field,suggested,final,suggested is not distinct from final,ext.model,ext.prompt_version,case when field='category' then ext.normalized->'category_suggestion'->>'scoringVersion' end);
 end loop;
 for line,idx in select value,(ordinality-1)::integer from jsonb_array_elements(new.snapshot->'lines') with ordinality loop
  source_ext:=null; orig_line:=null; source_idx:=null;
  -- Immutable line IDs identify the extraction that actually suggested this
  -- line, even if a later Gemini generation reorders or removes material rows.
  if line->>'id' ~ '^[0-9a-fA-F-]{36}:[0-9]{1,2}$' then
   select * into source_ext from public.extractions where id=split_part(line->>'id',':',1)::uuid and receipt_id=new.receipt_id;
   if found then
    source_idx:=split_part(line->>'id',':',2)::integer;
    select value into orig_line from jsonb_array_elements(source_ext.lines) with ordinality
     where coalesce((value->>'source_index')::integer,(ordinality-1)::integer)=source_idx limit 1;
   end if;
  end if;
  select * into suggestion from public.job_candidates where receipt_id=new.receipt_id
   and (id::text=line->>'suggestionId' or (extraction_id=source_ext.id and (source_index=source_idx or source_index is null)))
   order by (id::text is not distinct from line->>'suggestionId') desc,(source_index is not null) desc,score desc nulls last,id limit 1;
  select * into job_ext from public.extractions where id=suggestion.extraction_id;
  original:=jsonb_build_object('description',coalesce(orig_line->>'description',''),'qty',coalesce(orig_line->>'qty',''),'uom',coalesce(orig_line->>'uom',''),
   'unitCost',case when orig_line->>'unit_cost_cents' is null then '' else to_char((orig_line->>'unit_cost_cents')::numeric/100,'FM9999999990.00') end,'jobId',coalesce(suggestion.housecall_job_id,''));
  foreach field in array array['description','qty','uom','unitCost','jobId'] loop
   suggested:=original->field; final:=line->field;
   insert into public.receipt_intelligence_feedback(receipt_id,review_id,extraction_id,actor_id,field_path,suggested_value,final_value,accepted,model,prompt_version,scoring_version)
   values(new.receipt_id,new.id,case when field='jobId' then coalesce(job_ext.id,source_ext.id) else source_ext.id end,new.actor_id,'lines.'||idx||'.'||field,suggested,final,
    case when field in ('qty','unitCost') and nullif(suggested#>>'{}','') is not null and nullif(final#>>'{}','') is not null then (suggested#>>'{}')::numeric=(final#>>'{}')::numeric else suggested is not distinct from final end,
    case when field='jobId' then coalesce(job_ext.model,source_ext.model) else source_ext.model end,case when field='jobId' then coalesce(job_ext.prompt_version,source_ext.prompt_version) else source_ext.prompt_version end,case when field='jobId' then suggestion.scoring_version end);
  end loop;
 end loop;
 if new.decision='mark_duplicate' then
  update public.duplicate_candidates set status='confirmed',decided_by=new.actor_id,decided_at=now() where receipt_id=new.receipt_id and candidate_receipt_id=new.canonical_receipt_id;
 end if;
 return new;
end;$$;
create trigger reviews_capture_intelligence after insert on public.reviews for each row execute function public.capture_intelligence_feedback();

-- An extraction task cannot be marked successful without evidence for this
-- generation. An expired/stolen lease cannot finalize either provider result.
create or replace function public.complete_work(p_work_id uuid,p_worker_id text) returns public.work_items
 language plpgsql security definer set search_path='' as $$
declare rec public.work_items%rowtype;
begin
 select * into rec from public.work_items where id=p_work_id for update;
 if not found or rec.status<>'leased' or rec.lease_owner is distinct from p_worker_id or rec.lease_expires_at<=now() then raise exception 'conflict'; end if;
 if (rec.kind='readability' and not exists(select 1 from public.readability_checks where work_item_id=rec.id and receipt_id=rec.receipt_id))
 or (rec.kind='extract' and not exists(select 1 from public.extractions where work_item_id=rec.id and generation=rec.generation and receipt_id=rec.receipt_id)) then raise exception 'conflict'; end if;
 update public.work_items set status='succeeded',lease_owner=null,lease_expires_at=null,last_error=null,terminal_reason=null where id=rec.id returning * into rec;
 perform public.append_audit_event(rec.receipt_id,'work_completed',jsonb_build_object('kind',rec.kind,'attempt_count',rec.attempt_count),jsonb_build_object('status',rec.status),jsonb_build_object('worker_id',p_worker_id),'worker',null);
 return rec;
end;$$;
create function public.fail_dead_lettered_extraction() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if new.kind='extract' and new.status='dead_letter' and old.status is distinct from 'dead_letter' then
  update public.receipts set status='failed' where id=new.receipt_id and status='processing';
 end if;
 return new;
end;$$;
create trigger work_items_fail_dead_lettered_extraction after update of status on public.work_items for each row execute function public.fail_dead_lettered_extraction();
create function public.purge_duplicate_intelligence() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if new.content_deleted_at is not null and old.content_deleted_at is null then
  delete from public.duplicate_candidates where receipt_id=new.id or candidate_receipt_id=new.id;
 end if;
 return new;
end;$$;
create trigger receipts_purge_duplicate_intelligence before update of content_deleted_at on public.receipts for each row execute function public.purge_duplicate_intelligence();

revoke all on function public.configure_receipt_category(uuid,text,text,boolean,jsonb), public.dismiss_duplicate_candidate(uuid,uuid),
 public.request_receipt_reextraction(uuid,uuid), public.record_extraction_result(uuid,text,integer,jsonb,text,text,jsonb,jsonb),
 public.extraction_duplicate_inputs(uuid,text,text,integer,text,text,integer), public.capture_duplicate_decision(),public.validate_intelligence_review(),
 public.capture_intelligence_feedback(),public.fail_dead_lettered_extraction(),public.purge_duplicate_intelligence() from public,anon,authenticated;
grant execute on function public.configure_receipt_category(uuid,text,text,boolean,jsonb), public.dismiss_duplicate_candidate(uuid,uuid),
 public.request_receipt_reextraction(uuid,uuid), public.record_extraction_result(uuid,text,integer,jsonb,text,text,jsonb,jsonb),
 public.extraction_duplicate_inputs(uuid,text,text,integer,text,text,integer) to service_role;

-- Preserve manager field patches across re-extraction and display the top ranked job.
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

-- Hash candidates are available before provider extraction, but never change
-- receipt status or authorize export suppression without a manager decision.
create function public.record_exact_duplicate_candidates(p_work_id uuid,p_worker_id text,p_generation integer)
 returns integer language plpgsql security invoker set search_path='' as $$
declare item public.work_items%rowtype; hashes text[]; found_count integer;
begin
 select * into item from public.work_items where id=p_work_id for update;
 if not found or item.kind<>'extract' or item.status<>'leased' or item.lease_owner is distinct from p_worker_id or item.generation is distinct from p_generation or item.lease_expires_at<=now() then raise exception 'conflict'; end if;
 if not exists(select 1 from public.receipts where id=item.receipt_id and content_deleted_at is null and purge_claimed_at is null) then raise exception 'conflict'; end if;
 select array_agg(checksum order by checksum) into hashes from public.receipt_pages where receipt_id=item.receipt_id and confirmed_at is not null;
 if cardinality(hashes) is null or array_position(hashes,null) is not null then return 0; end if;
 insert into public.duplicate_candidates(receipt_id,candidate_receipt_id,score,reasons,scoring_version)
 select item.receipt_id,r.id,100,'[{"code":"exact_image_hash","message":"All receipt image checksums match."}]'::jsonb,'ra5-hash-v1'
 from public.receipts r where r.id<>item.receipt_id and r.content_deleted_at is null and r.purge_claimed_at is null and r.submitted_at is not null
 and exists(select 1 from public.receipt_pages p where p.receipt_id=r.id and p.checksum=any(hashes))
 and (select array_agg(checksum order by checksum) from public.receipt_pages where receipt_id=r.id and confirmed_at is not null)=hashes
 on conflict(receipt_id,candidate_receipt_id) do nothing;
 get diagnostics found_count=row_count;
 return found_count;
end;$$;
revoke all on function public.record_exact_duplicate_candidates(uuid,text,integer) from public,anon,authenticated;
grant execute on function public.record_exact_duplicate_candidates(uuid,text,integer) to service_role;

-- Lazy staff evidence lookup omits the full OCR transcript and original provider
-- observation. The server authenticates the actor before invoking this RPC.
create function public.manager_extraction_evidence(p_actor_id uuid,p_receipt_id uuid,p_extraction_id uuid)
 returns jsonb language plpgsql security invoker set search_path='' as $$
declare result jsonb;
begin
 perform public.require_active_actor(p_actor_id,array['manager','admin']);
 if not exists(select 1 from public.receipts where id=p_receipt_id and submitted_at is not null and content_deleted_at is null and purge_claimed_at is null) then raise exception 'forbidden'; end if;
 select e.field_evidence into result from receipt_private.extraction_evidence e where e.extraction_id=p_extraction_id and e.receipt_id=p_receipt_id;
 if not found then raise exception 'forbidden'; end if;
 return result;
end;$$;
revoke all on function public.manager_extraction_evidence(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.manager_extraction_evidence(uuid,uuid,uuid) to service_role;
create index receipt_categories_approved_by_idx on public.receipt_categories(approved_by);
create index duplicate_candidates_extraction_idx on public.duplicate_candidates(extraction_id);
create index duplicate_candidates_decider_idx on public.duplicate_candidates(decided_by);
create index duplicate_decisions_actor_idx on public.duplicate_candidate_decisions(actor_id);
create index receipt_feedback_actor_idx on public.receipt_intelligence_feedback(actor_id);
create index receipt_feedback_created_idx on public.receipt_intelligence_feedback(created_at,id);

-- Preserve extraction-specific failure classifications without persisting provider text.
create or replace function public.persistable_work_reason(p_reason text) returns text language sql immutable set search_path='' as $$
 select case when lower(trim(coalesce(p_reason,'')))=any(array[
  'retention_hold',
  'purge_not_eligible',
  'conflict',
  'storage_object_still_present',
  'storage_object_existence_unknown',
  'unhandled_work_kind',
  'deferred',
  'invalid_request',
  'forbidden',
  'provider_timeout',
  'provider_rate_limited',
  'provider_unavailable',
  'provider_invalid_response',
  'provider_empty_response',
  'provider_authentication_failed',
  'provider_request_rejected',
  'provider_not_configured',
  'provider_invalid_configuration',
  'provider_safety_refusal',
  'provider_output_truncated',
  'invalid_page_set',
  'storage_object_missing',
  'worker_failure'
 ]) then lower(trim(p_reason)) else 'worker_failure' end;
$$;
