-- RA-27 queue filtering, provenance, pagination and active-staff security.
-- Fixture writes only use the local database test role and are rolled back.
begin;
set local session_replication_role = replica;
insert into auth.users (id, aud, role, email) values
 ('27000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'ra27-worker@example.invalid'),
 ('27000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'ra27-manager@example.invalid'),
 ('27000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'ra27-disabled@example.invalid'),
 ('27000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'ra27-admin@example.invalid');
insert into public.profiles (id, role, disabled) values
 ('27000000-0000-4000-8000-000000000001', 'worker', false),
 ('27000000-0000-4000-8000-000000000002', 'manager', false),
 ('27000000-0000-4000-8000-000000000003', 'manager', true),
 ('27000000-0000-4000-8000-000000000004', 'admin', false);
insert into public.receipts (id, owner_user_id, status, submitted_at, content_deleted_at)
select ('27100000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,
 '27000000-0000-4000-8000-000000000001', status,
 case when n <= 2 then '2026-08-01T12:00:00.123456Z'::timestamptz
   when n = 3 then '2026-08-01T12:00:00.123457Z'::timestamptz
   when n = 15 then null else '2026-09-01T12:00:00Z'::timestamptz end,
 case when n = 14 then '2026-09-02T12:00:00Z'::timestamptz end
from (values (1,'needs_review'), (2,'needs_review'), (3,'needs_review'), (4,'submitted'), (5,'processing'),
 (6,'approved'),(7,'exporting'),(8,'exported'),(9,'partial_success'),(10,'failed'),(11,'rejected'),
 (12,'rejected_unreadable'),(13,'duplicate'),(14,'needs_review'),(15,'upload_pending')) v(n,status);
insert into public.extractions (id, receipt_id, provider, vendor, invoice_number, receipt_total_cents, confidence, raw_text, created_at) values
 ('27200000-0000-4000-8000-000000000001','27100000-0000-4000-8000-000000000001','gemini','Stale vendor','OLD',100,'{"vendor":0.1}','private raw text','2026-08-01T12:01Z'),
 ('27200000-0000-4000-8000-000000000002','27100000-0000-4000-8000-000000000001','gemini','Extracted vendor','INV-1',4289,'{"vendor":0.94,"total":0.91,"invalid":3,"wrong":"0.01"}','private raw text','2026-08-01T12:02Z'),
 ('27200000-0000-4000-8000-000000000003','27100000-0000-4000-8000-000000000002','gemini','Low supplier','INV-2',0,'{"vendor":0.3}','private raw text','2026-08-01T12:02Z');
insert into public.reviews (id, receipt_id, actor_id, decision, edits, created_at) values
 ('27300000-0000-4000-8000-000000000001','27100000-0000-4000-8000-000000000001','27000000-0000-4000-8000-000000000002','save_draft','{"vendor":"Before extraction"}','2026-08-01T12:01Z'),
 ('27300000-0000-4000-8000-000000000002','27100000-0000-4000-8000-000000000001','27000000-0000-4000-8000-000000000002','save_draft','{"vendor":"100% Supplier_","invoice_number":"DRAFT"}','2026-08-01T12:03Z'),
 ('27300000-0000-4000-8000-000000000003','27100000-0000-4000-8000-000000000001','27000000-0000-4000-8000-000000000002','request_clarification','{"invoice_number":"FINAL-REF","manager_notes":"private notes"}','2026-08-01T12:04Z');
insert into public.job_candidates (id, receipt_id, housecall_job_id, label, source, created_at) values
 ('27400000-0000-4000-8000-000000000001','27100000-0000-4000-8000-000000000001','old-job','Old label','import','2026-08-01T12:02Z'),
 ('27400000-0000-4000-8000-000000000002','27100000-0000-4000-8000-000000000001','job-27','Kitchen remodel','stored_source','2026-08-01T12:03Z');
insert into public.receipt_pages (receipt_id, page_index, storage_key, content_type, checksum, byte_size, confirmed_at) values
 ('27100000-0000-4000-8000-000000000001',0,'private/storage/page-0','image/jpeg',repeat('a',64),100,'2026-08-01T12:00Z'),
 ('27100000-0000-4000-8000-000000000001',1,'private/storage/page-1','image/jpeg',repeat('b',64),100,'2026-08-01T12:00Z'),
 ('27100000-0000-4000-8000-000000000001',2,'private/storage/page-2','image/jpeg',null,null,null);
insert into public.housecall_intents (id,receipt_id,created_at) values
 ('27500000-0000-4000-8000-000000000001','27100000-0000-4000-8000-000000000007','2026-08-01T12:00Z'),
 ('27500000-0000-4000-8000-000000000002','27100000-0000-4000-8000-000000000007','2026-08-02T12:00Z'),
 ('27500000-0000-4000-8000-000000000003','27100000-0000-4000-8000-000000000007','2026-08-04T12:00Z'),
 ('27500000-0000-4000-8000-000000000004','27100000-0000-4000-8000-000000000011','2026-08-04T12:00Z');
insert into public.housecall_outbox (receipt_id,intent_id,status) values
 ('27100000-0000-4000-8000-000000000007','27500000-0000-4000-8000-000000000002','dispatched'),
 ('27100000-0000-4000-8000-000000000011','27500000-0000-4000-8000-000000000004','cancelled');
insert into public.export_attempts (id, receipt_id, intent_id, housecall_job_id, step, status, idempotency_key, created_at) values
 ('27600000-0000-4000-8000-000000000001','27100000-0000-4000-8000-000000000007','27500000-0000-4000-8000-000000000001','job-old','attachment','permanent_failure','ra27-old','2026-08-03T12:00Z'),
 ('27600000-0000-4000-8000-000000000002','27100000-0000-4000-8000-000000000007','27500000-0000-4000-8000-000000000002','job-new','attachment','retryable_failure','ra27-retry-old','2026-08-03T12:00Z'),
 ('27600000-0000-4000-8000-000000000003','27100000-0000-4000-8000-000000000007','27500000-0000-4000-8000-000000000002','job-new','attachment','succeeded','ra27-current','2026-08-03T12:01Z'),
 ('27600000-0000-4000-8000-000000000004','27100000-0000-4000-8000-000000000007','27500000-0000-4000-8000-000000000003','job-stray','attachment','permanent_failure','ra27-stray','2026-08-04T12:01Z');
set local session_replication_role = origin;

-- Authorization is exercised as the actual authenticated SQL role, with RLS on.
set local role authenticated;
select set_config('request.jwt.claim.sub','27000000-0000-4000-8000-000000000002',true);
do $$
declare rows jsonb[]; item jsonb; keys text[]; cursor_stamp timestamptz; cursor_id uuid; invalid jsonb;
begin
  select array_agg(q) into rows from public.manager_review_queue(p_submitter=>'27000000-0000-4000-8000-000000000001') q;
  if cardinality(rows) <> 3 or rows[1]->>'id' <> '27100000-0000-4000-8000-000000000001'
    or rows[2]->>'id' <> '27100000-0000-4000-8000-000000000002'
    or rows[3]->>'id' <> '27100000-0000-4000-8000-000000000003' then raise exception 'default queue must be oldest-first, one row per document, with UUID ties'; end if;
  item := rows[1];
  if item->>'submittedAt' <> '2026-08-01T12:00:00.123456Z' or item->>'vendor' <> '100% Supplier_'
    or item->>'reference' <> 'FINAL-REF' or (item->>'referenceTotalCents')::integer <> 4289
    or (item->>'confidence')::numeric <> 0.91 or item->>'latestReviewDecision' <> 'request_clarification'
    or item->'suggestedJob'->>'id' <> 'job-27' or (item->>'pageCount')::integer <> 2
    or not (item->>'hasThumbnail')::boolean then raise exception 'latest extraction, sparse edits, confidence or page provenance lost'; end if;
  if item::text like '%private%' or item ? 'raw_text' or item ? 'storage_key' then raise exception 'queue leaked protected source details'; end if;
  if rows[3]->>'confidence' is not null or rows[3]->>'vendor' is not null or rows[3]->>'suggestedJob' is not null then raise exception 'missing data must not be fabricated'; end if;
  select array_agg(q) into rows from public.manager_review_queue(p_submitter=>'27000000-0000-4000-8000-000000000001',p_limit=>1) q;
  cursor_stamp := (rows[1]->>'submittedAt')::timestamptz; cursor_id := (rows[1]->>'id')::uuid;
  select array_agg(q) into rows from public.manager_review_queue(p_submitter=>'27000000-0000-4000-8000-000000000001',p_limit=>1,p_cursor_at=>cursor_stamp,p_cursor_id=>cursor_id) q;
  if cardinality(rows) <> 1 or rows[1]->>'id' <> '27100000-0000-4000-8000-000000000002' then raise exception 'equal timestamp cursor skipped/duplicated a row'; end if;
  select array_agg(q) into rows from public.manager_review_queue(p_submitter=>'27000000-0000-4000-8000-000000000001',p_sort=>'newest',p_cursor_at=>'2026-08-01T12:00:00.123457Z',p_cursor_id=>'27100000-0000-4000-8000-000000000003') q;
  if cardinality(rows) <> 2 or rows[1]->>'id' <> '27100000-0000-4000-8000-000000000002' then raise exception 'descending microsecond cursor incorrect'; end if;
  if (select count(*) from public.manager_review_queue(p_vendor=>'100%',p_search=>'supplier_',p_confidence=>'high')) <> 1
    or (select count(*) from public.manager_review_queue(p_search=>'FINAL-REF')) <> 1
    or (select count(*) from public.manager_review_queue(p_confidence=>'low')) <> 1
    or (select count(*) from public.manager_review_queue(p_confidence=>'unknown')) <> 1
    or (select count(*) from public.manager_review_queue(p_vendor=>'Stale vendor')) <> 0
    or (select count(*) from public.manager_review_queue(p_search=>'job-27')) <> 1
    or (select count(*) from public.manager_review_queue(p_submitter=>'27000000-0000-4000-8000-000000000004')) <> 0
    then raise exception 'server filters do not apply before pagination or use stale values'; end if;
  if (select count(*) from public.manager_review_queue(p_age=>'over-30d',p_as_of=>'2026-09-07T12:00Z')) <> 3
    or (select count(*) from public.manager_review_queue(p_age=>'over-30d',p_as_of=>'2026-08-15T12:00Z')) <> 0
    or (select count(*) from public.manager_review_queue(p_from=>'2026-08-01',p_to=>'2026-08-01')) <> 3
    or (select count(*) from public.manager_review_queue(p_from=>'2026-08-02')) <> 0 then raise exception 'age/date UTC boundaries incorrect'; end if;
  if (select count(*) from public.manager_review_queue(p_tab=>'processing')) <> 4
    or (select count(*) from public.manager_review_queue(p_tab=>'completed')) <> 1
    or (select count(*) from public.manager_review_queue(p_tab=>'failed')) <> 1
    or (select count(*) from public.manager_review_queue(p_tab=>'partial-success')) <> 1
    or (select count(*) from public.manager_review_queue(p_tab=>'rejected-duplicate')) <> 3
    or (select count(*) from public.manager_review_queue(p_tab=>'processing',p_status=>'submitted')) <> 1
    or (select count(*) from public.manager_review_queue(p_tab=>'rejected-duplicate',p_duplicate=>'marked')) <> 1
    or (select count(*) from public.manager_review_queue(p_tab=>'rejected-duplicate',p_duplicate=>'unmarked')) <> 2 then raise exception 'tab/state/duplicate grouping incorrect'; end if;
  if (select count(*) from public.manager_review_queue(p_tab=>'processing',p_housecall=>'failed')) <> 0
    or (select count(*) from public.manager_review_queue(p_tab=>'processing',p_housecall=>'in_progress')) <> 1
    or (select count(*) from public.manager_review_queue(p_tab=>'rejected-duplicate',p_housecall=>'cancelled')) <> 1
    or (select count(*) from public.manager_review_queue(p_tab=>'completed',p_housecall=>'succeeded')) <> 1 then raise exception 'Housecall status included stale intent or superseded attempt'; end if;
  begin perform public.manager_review_queue(p_limit=>52); raise exception 'unbounded limit accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.manager_review_queue(p_tab=>'all'); raise exception 'bad tab accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.manager_review_queue(p_cursor_id=>'27100000-0000-4000-8000-000000000001'); raise exception 'partial cursor accepted'; exception when invalid_parameter_value then null; end;
end;
$$;
select set_config('request.jwt.claim.sub','27000000-0000-4000-8000-000000000001',true);
do $$ begin
  begin perform public.manager_review_queue(); raise exception 'worker accessed manager queue'; exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','27000000-0000-4000-8000-000000000003',true);
do $$ begin
  begin perform public.manager_review_queue(); raise exception 'disabled manager accessed queue'; exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','27000000-0000-4000-8000-000000000004',true);
do $$ begin
  if (select count(*) from public.manager_review_queue()) <> 3 then raise exception 'admin cannot access queue'; end if;
end $$;
reset role;
do $$
declare signature regprocedure := 'public.manager_review_queue(text,text,text,text,uuid,text,text,text,text,text,date,date,integer,timestamptz,timestamptz,uuid)'::regprocedure;
begin
  if has_function_privilege('anon',signature,'EXECUTE') or has_function_privilege('public',signature,'EXECUTE')
    or has_function_privilege('service_role',signature,'EXECUTE') or not has_function_privilege('authenticated',signature,'EXECUTE') then raise exception 'queue RPC grants invalid'; end if;
  if exists(select 1 from pg_proc where oid=signature and prosecdef) then raise exception 'queue must preserve caller RLS'; end if;
  if not exists(select 1 from pg_indexes where schemaname='public' and indexname='receipts_manager_queue_order_idx')
    or not exists(select 1 from pg_indexes where schemaname='public' and indexname='receipts_manager_queue_status_order_idx') then raise exception 'missing queue indexes'; end if;
end $$;
rollback;
