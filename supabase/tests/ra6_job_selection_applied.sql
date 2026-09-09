-- RA-43 local search/approval regressions. Entire suite rolls back; no HTTP.
begin;
insert into auth.users(id,aud,role,email) values
 ('67000000-0000-4000-8000-000000000001','authenticated','authenticated','ra6select-worker@example.invalid'),
 ('67000000-0000-4000-8000-000000000002','authenticated','authenticated','ra6select-manager@example.invalid');
update public.profiles set role='manager' where id='67000000-0000-4000-8000-000000000002';
insert into public.receipt_categories(id,label) values('ra6select-materials','RA6 selection test materials');
insert into public.receipts(id,owner_user_id,status,submitted_at) values
 ('67100000-0000-4000-8000-000000000001','67000000-0000-4000-8000-000000000001','needs_review',now());
insert into public.manager_job_catalog(id,label,customer,job_number,status,scheduled_at,active,unavailable,source,synced_at) values
 ('ra6select-active-current','RA6 current','Synthetic','C1','scheduled',now()+interval '1 day',true,false,'housecall',now()),
 ('ra6select-active-old','RA6 old scheduled','Synthetic','C2','scheduled',now()-interval '40 days',true,false,'housecall',now()),
 ('ra6select-active-future','RA6 future scheduled','Synthetic','C3','scheduled',now()+interval '100 days',true,false,'housecall',now()),
 ('ra6select-active-unknown','RA6 missing schedule','Synthetic','C4','scheduled',null,true,false,'housecall',now()-interval '2 days'),
 ('ra6select-in-progress','RA6 in progress','Synthetic','C5','in progress',now()-interval '2 years',true,false,'housecall',now()),
 ('ra6select-unscheduled','RA6 unscheduled','Synthetic','C6','needs scheduling',now()-interval '2 years',true,false,'housecall',now()),
 ('ra6select-completed-recent','RA6 completed recently','Synthetic','C7','complete rated',now()-interval '10 days',false,false,'housecall',now()),
 ('ra6select-completed-old','RA6 completed old','Synthetic','C8','complete unrated',now()-interval '40 days',false,false,'housecall',now()),
 ('ra6select-unavailable','RA6 canceled','Synthetic','C9','scheduled',now(),true,true,'housecall',now()),
 ('ra6select-literal','RA6 literal %_ job','Synthetic','C10','scheduled',now(),true,false,'housecall',now());
insert into public.job_candidates(receipt_id,housecall_job_id,label,source) values
 ('67100000-0000-4000-8000-000000000001','ra6select-unavailable','Historic suggested job','receipt_intelligence');
set local role service_role;
do $$
declare
 snapshot jsonb:='{"vendor":"SYNTHETIC RA6 TEST","purchaseDate":"2026-09-09","invoiceNumber":"RA6-SELECT-TEST","ticketNumber":"","category":"ra6select-materials","referenceTotal":"2.00","managerNotes":"","lines":[{"description":"Test A","qty":"1","uom":"ea","unitCost":"1.00","jobId":"ra6select-active-current"},{"description":"Test B","qty":"1","uom":"ea","unitCost":"1.00","jobId":"ra6select-unavailable"}]}';
 result jsonb;
begin
 -- Drafts preserve history; approval must recheck the current catalog and
 -- atomically reject the WHOLE receipt even if a saved suggestion exists.
 result:=public.manager_review_command('67100000-0000-4000-8000-000000000001','67000000-0000-4000-8000-000000000002',0,null,'save_draft',snapshot);
 begin
  perform public.manager_review_command('67100000-0000-4000-8000-000000000001','67000000-0000-4000-8000-000000000002',1,null,'approve',snapshot);
  raise exception 'unavailable saved candidate approved';
 exception when others then if sqlerrm<>'invalid_request_job_unavailable' or sqlstate<>'23514' then raise;end if;end;
 if (select status from public.receipts where id='67100000-0000-4000-8000-000000000001')<>'needs_review'
  or (select review_version from public.receipts where id='67100000-0000-4000-8000-000000000001')<>1
  or exists(select 1 from public.reviews where receipt_id='67100000-0000-4000-8000-000000000001' and decision='approve')
  or exists(select 1 from public.receipt_lines where receipt_id='67100000-0000-4000-8000-000000000001')
  or exists(select 1 from public.housecall_intents where receipt_id='67100000-0000-4000-8000-000000000001')
  or exists(select 1 from public.housecall_outbox where receipt_id='67100000-0000-4000-8000-000000000001')
  or exists(select 1 from public.work_items where receipt_id='67100000-0000-4000-8000-000000000001' and kind='export') then raise exception 'blocked approval partially exported';end if;
 -- An ordinary available assignment retains prior approval behavior.
 result:=public.manager_review_command('67100000-0000-4000-8000-000000000001','67000000-0000-4000-8000-000000000002',1,null,'approve',jsonb_set(snapshot,'{lines,1,jobId}','"ra6select-active-current"'));
 if result->>'status'<>'approved' then raise exception 'available approval regressed';end if;
end;$$;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','67000000-0000-4000-8000-000000000002',true);
do $$
declare ids text[]; row_data public.manager_job_catalog%rowtype;
begin
 select array_agg(j.id order by j.id) into ids from public.manager_search_housecall_jobs('ra6select-') j;
 if ids is distinct from array['ra6select-active-current','ra6select-active-unknown','ra6select-completed-recent','ra6select-in-progress','ra6select-literal','ra6select-unscheduled'] then raise exception 'default active/recent window incorrect: %',ids;end if;
 if (select count(*) from public.manager_search_housecall_jobs('ra6select-',false))<>10 then raise exception 'all scope lost archived/unavailable jobs';end if;
 if not exists(select 1 from public.manager_search_housecall_jobs('ra6select-',false) j where j.id='ra6select-unavailable' and j.unavailable) then raise exception 'all scope hid unavailable state';end if;
 if not exists(select 1 from public.manager_search_housecall_jobs('ra6select-',true,50,now()-interval '60 days',now()+interval '120 days') j where j.id='ra6select-active-old')
  or not exists(select 1 from public.manager_search_housecall_jobs('ra6select-',true,50,now()-interval '60 days',now()+interval '120 days') j where j.id='ra6select-active-future')
  or not exists(select 1 from public.manager_search_housecall_jobs('ra6select-',true,50,now()-interval '60 days',now()+interval '120 days') j where j.id='ra6select-completed-old') then raise exception 'configured window ignored';end if;
 select * into row_data from public.manager_search_housecall_jobs('ra6select-active-unknown');
 if row_data.source<>'housecall' or row_data.synced_at is distinct from now()-interval '2 days' or row_data.id<>'ra6select-active-unknown' then raise exception 'freshness or identity stripped';end if;
 if (select count(*) from public.manager_search_housecall_jobs('%_',false))<>1 then raise exception 'search wildcard interpreted as pattern';end if;
 if exists(select 1 from public.manager_search_housecall_jobs(''' OR true --',false)) then raise exception 'search text executed';end if;
 if (select count(*) from public.manager_search_housecall_jobs('ra6select-',false,2))<>2 then raise exception 'search limit ignored';end if;
 perform public.manager_search_housecall_jobs('ra6select-',true,50,now()-interval '365 days 30 seconds',now()+interval '365 days 30 seconds');
 begin perform public.manager_search_housecall_jobs('',true,51);raise exception 'unbounded result limit accepted';exception when others then if sqlerrm<>'invalid_request' then raise;end if;end;
 begin perform public.manager_search_housecall_jobs('',true,50,now()-interval '400 days',now()+interval '90 days');raise exception 'unbounded lookback accepted';exception when others then if sqlerrm<>'invalid_request' then raise;end if;end;
 begin perform public.manager_search_housecall_jobs('',true,50,now()-interval '30 days','infinity');raise exception 'infinite window accepted';exception when others then if sqlerrm<>'invalid_request' then raise;end if;end;
 begin perform public.manager_search_housecall_jobs('',true,50,now()+interval '1 day',now()-interval '1 day');raise exception 'reversed window accepted';exception when others then if sqlerrm<>'invalid_request' then raise;end if;end;
end;$$;
select set_config('request.jwt.claim.sub','67000000-0000-4000-8000-000000000001',true);
do $$begin
 begin perform public.manager_search_housecall_jobs();raise exception 'worker catalog access accepted';exception when others then if sqlerrm<>'forbidden' then raise;end if;end;
 if has_function_privilege('anon','public.manager_search_housecall_jobs(text,boolean,integer,timestamptz,timestamptz)','EXECUTE') then raise exception 'anonymous catalog search granted';end if;
end;$$;
reset role;
rollback;
