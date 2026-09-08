-- RA-5 applied invariants. Synthetic data only; no external requests; rollback.
begin;
insert into auth.users(id,aud,role,email) values
 ('55000000-0000-4000-8000-000000000001','authenticated','authenticated','ra5-worker@example.invalid'),
 ('55000000-0000-4000-8000-000000000002','authenticated','authenticated','ra5-manager@example.invalid'),
 ('55000000-0000-4000-8000-000000000003','authenticated','authenticated','ra5-admin@example.invalid');
update public.profiles set role='manager' where id='55000000-0000-4000-8000-000000000002';
update public.profiles set role='admin' where id='55000000-0000-4000-8000-000000000003';
insert into public.receipts(id,owner_user_id,status,submitted_at)
 select ('55100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'55000000-0000-4000-8000-000000000001','processing',now() from generate_series(1,3)n;
insert into public.receipt_pages(receipt_id,page_index,storage_key,content_type,checksum,byte_size,confirmed_at)
 select id,0,owner_user_id||'/'||id||'/page-0.jpg','image/jpeg',case when id='55100000-0000-4000-8000-000000000002' then repeat('e',64) else repeat('d',64) end,100,now() from public.receipts where id::text like '55100000%';
insert into public.work_items(receipt_id,kind,status,lease_owner,lease_expires_at,attempt_count)
 select id,'readability','succeeded',null,null,1 from public.receipts where id::text like '55100000%';
insert into public.readability_checks(work_item_id,receipt_id,schema_version,provider,model,readable) select id,receipt_id,1,'google_gemini','test-flash',true from public.work_items where receipt_id::text like '55100000%' and kind='readability';
insert into public.work_items(receipt_id,kind,status,lease_owner,lease_expires_at,attempt_count)
 select id,'extract','leased','ra5-worker',now()+interval '5 minutes',1 from public.receipts where id::text like '55100000%';
insert into public.manager_job_catalog(id,label) values('ra5-job-a','Fixture job');
set local role service_role;
do $$
declare
 receipt uuid:='55100000-0000-4000-8000-000000000001'; other uuid:='55100000-0000-4000-8000-000000000002'; manager uuid:='55000000-0000-4000-8000-000000000002'; admin_id uuid:='55000000-0000-4000-8000-000000000003';
 work uuid; ext uuid; second_ext uuid; duplicate_id uuid; result jsonb;
 parsed jsonb:='{"schema_version":1,"provider":"gemini","vendor":"Synthetic Vendor","purchase_date":"2026-09-08","invoice_number":"TEST-55","ticket_number":null,"receipt_total_cents":16171,"tax_cents":1129,"lines":[{"source_index":0,"page_index":0,"description":"Stone","qty":6.09,"uom":"ton","unit_cost_cents":2470,"extended_cost_cents":15042},{"source_index":2,"page_index":0,"description":"Faint line","qty":null,"unit_cost_cents":null}],"confidence":{"vendor":0.99},"warnings":[{"code":"missing_field","field":"lines.1.qty","message":"Needs review"}],"raw_text":"PRIVATE OCR","evidence":[{"field":"vendor","text":"PRIVATE EVIDENCE","page_index":0,"confidence":0.9}],"original_observation":{"raw_text":"PRIVATE ORIGINAL"}}';
 intelligence jsonb:='{"categorySuggestion":{"categoryId":"test_materials","confidence":0.9,"reasons":[],"scoringVersion":"ra5-rules-v1"},"jobCandidates":[{"jobId":"ra5-job-a","label":"Fixture job","score":1080,"reasons":[{"code":"exact_reference","message":"Reference matches"}],"scoringVersion":"ra5-rules-v1"}],"duplicateCandidates":[{"receiptId":"55100000-0000-4000-8000-000000000002","score":100,"reasons":[{"code":"exact_image_hash","message":"Image matches"}],"scoringVersion":"ra5-rules-v1"}]}';
 draft jsonb:='{"vendor":"Manager vendor","purchaseDate":"2026-09-08","invoiceNumber":"TEST-55","ticketNumber":"","category":"test_materials","referenceTotal":"161.71","managerNotes":"","lines":[{"description":"Manager stone","qty":"6.090","uom":"ton","unitCost":"24.70","jobId":"ra5-job-a","sourceIndex":0}]}';
begin
 perform public.configure_receipt_category(admin_id,'test_materials','Test materials',true,'["Stone"]');
 insert into public.extractions(receipt_id,provider,vendor,purchase_date,receipt_total_cents,invoice_number) values(other,'gemini','SYNTHETIC, VENDOR','2026-09-08',16171,'TEST 55');
 if not exists(select 1 from public.extraction_duplicate_inputs(receipt,'Synthetic Vendor','2026-09-08',16171,'TEST-55',null) candidate where candidate->>'id'=other::text) then raise exception 'punctuation-normalized candidate omitted';end if;
 if public.normalize_receipt_match_text('Lowe’s')<>public.normalize_receipt_match_text('Lowe''s') then raise exception 'unicode apostrophe mismatch';end if;
 begin perform public.configure_receipt_category(manager,'bad','Bad',true);raise exception 'manager category config allowed';exception when others then if sqlerrm<>'forbidden' then raise;end if;end;
 select id into work from public.work_items where receipt_id=receipt and kind='extract';
 update public.work_items set lease_expires_at=now()-interval '1 second' where id=work;
 begin perform public.record_extraction_result(work,'ra5-worker',1,parsed,'test-flash','test-prompt');raise exception 'expired lease allowed';exception when others then if sqlerrm<>'conflict' then raise;end if;end;
 update public.work_items set lease_expires_at=now()+interval '5 minutes' where id=work;
 begin perform public.complete_work(work,'ra5-worker');raise exception 'evidence-free completion allowed';exception when others then if sqlerrm<>'conflict' then raise;end if;end;
 begin perform public.record_extraction_result(work,'wrong-owner',1,parsed,'test-flash','test-prompt','{}',intelligence);raise exception 'stolen lease allowed';exception when others then if sqlerrm<>'conflict' then raise;end if;end;
 if public.record_exact_duplicate_candidates(work,'ra5-worker',1)<1 or (select status from public.receipts where id=receipt)<>'processing' then raise exception 'early exact duplicate advisory missing or changed status';end if;
 result:=public.record_extraction_result(work,'ra5-worker',1,parsed,'test-flash','test-prompt','{}',intelligence);ext:=(result->>'id')::uuid;
 result:=public.record_extraction_result(work,'ra5-worker',1,parsed,'test-flash','test-prompt','{}',intelligence);
 if (result->>'id')::uuid<>ext or (select count(*) from public.extractions where receipt_id=receipt)<>1 then raise exception 'extraction replay duplicated evidence';end if;
 if (select status from public.receipts where id=receipt)<>'needs_review' or (select count(*) from public.receipt_lines where receipt_id=receipt)<>1 then raise exception 'normalized projection wrong';end if;
 if (select jsonb_array_length(lines) from public.extractions where id=ext)<>2 then raise exception 'incomplete line lost';end if;
 if (select round(qty*unit_cost_cents) from public.receipt_lines where receipt_id=receipt)<>15042 then raise exception 'reference tax changed material cost';end if;
 if (select raw_text is not null or normalized::text like '%PRIVATE%' from public.extractions where id=ext) then raise exception 'raw evidence exposed';end if;
 if (select raw_text from receipt_private.extraction_evidence where extraction_id=ext)<>'PRIVATE OCR' then raise exception 'raw evidence not retained';end if;
 begin update public.extractions set vendor='Changed' where id=ext;raise exception 'immutable extraction editable';exception when others then if sqlerrm not like '%append-only' then raise;end if;end;
 perform public.complete_work(work,'ra5-worker');
 draft:=jsonb_set(draft,'{lines,0,id}',to_jsonb(ext::text||':0'));
 draft:=jsonb_set(draft,'{lines}',(draft->'lines')||jsonb_build_array(jsonb_build_object('id',ext::text||':2','sourceIndex',2,'description','Corrected faint','qty','1','uom','ea','unitCost','1.00','jobId','ra5-job-a'),jsonb_build_object('id',gen_random_uuid()::text,'description','Manual addition','qty','1','uom','ea','unitCost','1.00','jobId','ra5-job-a')));
 perform public.manager_review_command(receipt,manager,0,ext,'save_draft',draft);
 if not exists(select 1 from public.receipt_intelligence_feedback where receipt_id=receipt and field_path='vendor' and accepted=false and suggested_value='"Synthetic Vendor"' and final_value='"Manager vendor"') then raise exception 'field correction missing';end if;
 if not exists(select 1 from public.receipt_intelligence_feedback where receipt_id=receipt and field_path='lines.1.description' and suggested_value='"Faint line"' and extraction_id=ext) then raise exception 'sparse source index feedback wrong';end if;
 if exists(select 1 from public.receipt_intelligence_feedback where receipt_id=receipt and field_path like 'lines.2.%' and (extraction_id is not null or model is not null)) then raise exception 'manual addition attributed to model';end if;
 if not exists(select 1 from public.receipt_intelligence_feedback where receipt_id=receipt and field_path='lines.0.qty' and accepted=true) then raise exception 'equivalent decimal feedback wrong';end if;
 select id into duplicate_id from public.duplicate_candidates where receipt_id=receipt and candidate_receipt_id=other;
 perform public.dismiss_duplicate_candidate(duplicate_id,manager);
 if not exists(select 1 from public.duplicate_candidate_decisions where candidate_id=duplicate_id and status='dismissed') then raise exception 'duplicate dismissal history missing';end if;
 perform public.request_receipt_reextraction(receipt,manager);
 update public.work_items set status='leased',lease_owner='ra5-worker',lease_expires_at=now()+interval '5 minutes' where id=work;
 result:=public.record_extraction_result(work,'ra5-worker',2,jsonb_set(jsonb_set(parsed,'{vendor}','"Reprocessed vendor"'),'{lines}',jsonb_build_array(parsed->'lines'->1,parsed->'lines'->0)),'test-flash-v2','test-prompt-v2','{}',intelligence);second_ext:=(result->>'id')::uuid;
 if second_ext=ext or (select count(*) from public.extractions where receipt_id=receipt)<>2 then raise exception 'reprocessing reused extraction';end if;
 if (select description from public.receipt_lines where receipt_id=receipt)<>'Stone' or (select snapshot->>'vendor' from public.reviews where receipt_id=receipt order by version desc limit 1)<>'Manager vendor' then raise exception 'reprocessing overwrote manager state';end if;
 if (select status from public.duplicate_candidates where id=duplicate_id)<>'dismissed' then raise exception 'dismissal reset on reprocess';end if;
 perform public.complete_work(work,'ra5-worker');
 begin perform public.manager_review_command(receipt,manager,1,ext,'approve',draft);raise exception 'stale extraction allowed';exception when others then if sqlerrm<>'conflict_stale_review' then raise;end if;end;
 perform public.configure_receipt_category(admin_id,'test_materials','Test materials',false,'["Stone"]');
 begin perform public.manager_review_command(receipt,manager,1,second_ext,'approve',draft);raise exception 'inactive category approved';exception when others then if sqlerrm<>'invalid_request_category' then raise;end if;end;
 perform public.manager_review_command(receipt,manager,1,second_ext,'mark_duplicate',draft,'Synthetic duplicate',other);
 if not exists(select 1 from public.receipt_intelligence_feedback f join public.reviews r on r.id=f.review_id where r.receipt_id=receipt and r.version=2 and f.field_path='lines.0.description' and f.extraction_id=ext and f.model='test-flash') then raise exception 'reprocessed line feedback origin lost';end if;
 if exists(select 1 from public.housecall_outbox where receipt_id=receipt) or (select status from public.duplicate_candidates where id=duplicate_id)<>'confirmed' then raise exception 'duplicate exported or decision not captured';end if;
 -- Terminal provider failure is visible without labeling an accepted image unreadable.
 select id into work from public.work_items where receipt_id='55100000-0000-4000-8000-000000000003' and kind='extract';
 perform public.fail_work(work,'ra5-worker','provider_safety_refusal',false);
 if (select terminal_reason from public.work_items where id=work)<>'provider_safety_refusal' then raise exception 'normalized safety classification lost';end if;
 if (select status from public.receipts where id='55100000-0000-4000-8000-000000000003')<>'failed' then raise exception 'permanent extraction failure hidden';end if;
end;$$;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','55000000-0000-4000-8000-000000000001',true);
do $$begin
 if has_schema_privilege('authenticated','receipt_private','USAGE') or has_table_privilege('authenticated',(select c.oid from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='receipt_private' and c.relname='extraction_evidence'),'SELECT') then raise exception 'private OCR readable';end if;
 if exists(select 1 from public.duplicate_candidates where receipt_id::text like '55100000%') or exists(select 1 from public.receipt_intelligence_feedback where receipt_id::text like '55100000%') then raise exception 'worker intelligence leak';end if;
 if has_function_privilege('authenticated','public.record_extraction_result(uuid,text,integer,jsonb,text,text,jsonb,jsonb)','EXECUTE') then raise exception 'public result mutation';end if;
end;$$;
reset role;
-- Real purge transaction must cascade private OCR, observations, feedback, and
-- reverse duplicate links before content disappears from candidate lookups.
update public.receipts set delete_after_at=now()-interval '1 second',purge_claimed_at=now(),purge_claimed_by='ra5-purge' where id='55100000-0000-4000-8000-000000000001';
insert into public.work_items(receipt_id,kind,status,lease_owner,lease_expires_at,attempt_count) values('55100000-0000-4000-8000-000000000001','purge','leased','ra5-purge',now()+interval '5 minutes',1) on conflict(receipt_id,kind) do update set status='leased',lease_owner='ra5-purge',lease_expires_at=now()+interval '5 minutes';
set local role service_role;
select public.purge_receipt_content('55100000-0000-4000-8000-000000000001','ra5-purge');
do $$begin
 if exists(select 1 from receipt_private.extraction_evidence where receipt_id='55100000-0000-4000-8000-000000000001') or exists(select 1 from public.receipt_intelligence_feedback where receipt_id='55100000-0000-4000-8000-000000000001') or exists(select 1 from public.duplicate_candidates where receipt_id='55100000-0000-4000-8000-000000000001') then raise exception 'retained purged intelligence';end if;
end;$$;
rollback;
