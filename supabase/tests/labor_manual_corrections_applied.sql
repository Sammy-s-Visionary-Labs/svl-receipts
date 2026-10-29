-- Synthetic rollback-only checks. No provider calls or real source mutations survive.
begin;
insert into auth.users(id,aud,role,email,raw_app_meta_data) values
 ('95000000-0000-4000-8000-000000000001','authenticated','authenticated','manual-manager@example.invalid','{"svl_access_approved":true}'),
 ('95000000-0000-4000-8000-000000000002','authenticated','authenticated','manual-worker@example.invalid','{"svl_access_approved":true}');
update public.profiles set role='manager' where id='95000000-0000-4000-8000-000000000001';
insert into public.labor_job_hour_approvals(id,snapshot,canonical_snapshot,snapshot_hash,source_revision,source_fingerprint,status,approved_by,sent_at,provider_reference) values
 ('95000000-0000-4000-8000-000000000010','{}','{}',repeat('a',64),0,repeat('b',64),'sent','95000000-0000-4000-8000-000000000001',clock_timestamp(),'TEST_ORIGINAL'),
 ('95000000-0000-4000-8000-000000000011','{}','{}',repeat('c',64),0,repeat('b',64),'approved','95000000-0000-4000-8000-000000000001',null,null),
 ('95000000-0000-4000-8000-000000000012','{}','{}',repeat('d',64),0,repeat('b',64),'sending','95000000-0000-4000-8000-000000000001',null,null),
 ('95000000-0000-4000-8000-000000000013','{}','{}',repeat('e',64),0,repeat('b',64),'reconciliation_required','95000000-0000-4000-8000-000000000001',null,null);
insert into public.labor_job_hour_attempts(approval_id,actor_id,source_revision,status,dispatched_at,completed_at) values
 ('95000000-0000-4000-8000-000000000010','95000000-0000-4000-8000-000000000001',0,'sent',clock_timestamp(),clock_timestamp()),
 ('95000000-0000-4000-8000-000000000012','95000000-0000-4000-8000-000000000001',0,'dispatched',clock_timestamp(),null),
 ('95000000-0000-4000-8000-000000000013','95000000-0000-4000-8000-000000000001',0,'uncertain',clock_timestamp(),clock_timestamp());
insert into public.labor_job_hour_reservations(approval_id,source_entry_id,worker_name_key,work_date,start_minute,end_minute)
 values('95000000-0000-4000-8000-000000000010','TEST_MANUAL_ROW','TEST MANUAL WORKER','2026-10-01',480,540),
 ('95000000-0000-4000-8000-000000000013','TEST_MANUAL_UNCERTAIN','TEST MANUAL WORKER','2026-10-01',540,600);

create function pg_temp.record_resolution(p_approval uuid default '95000000-0000-4000-8000-000000000010',p_request uuid default '95000000-0000-4000-8000-000000000020',p_hash text default repeat('a',64),p_actor uuid default '95000000-0000-4000-8000-000000000001',p_reason text default 'TEST corrected after manager review') returns jsonb language sql as $$
 select public.record_labor_manual_correction(p_approval,p_request,p_hash,p_actor,p_reason,'TEST_CORRECTED_MATERIAL','TEST manager verified revised material amount on job');
$$;
do $$ declare fn record; begin
 if not(select relrowsecurity from pg_class where oid='public.labor_manual_corrections'::regclass)
  or has_table_privilege('authenticated','public.labor_manual_corrections','SELECT')
  or has_table_privilege('anon','public.labor_manual_corrections','INSERT')
  or has_table_privilege('service_role','public.labor_manual_corrections','UPDATE')
  or has_table_privilege('service_role','public.labor_manual_corrections','DELETE') then raise exception 'manual resolution service boundary missing';end if;
 for fn in select oid,prosecdef from pg_proc where pronamespace='public'::regnamespace and proname in ('read_labor_manual_corrections','record_labor_manual_correction') loop
  if fn.prosecdef or has_function_privilege('authenticated',fn.oid,'EXECUTE') or has_function_privilege('anon',fn.oid,'EXECUTE') or not has_function_privilege('service_role',fn.oid,'EXECUTE') then raise exception 'manual resolution RPC exposed';end if;
 end loop;
end; $$;
set local role service_role;
do $$ declare saved jsonb; repeated jsonb; before_approval jsonb; before_reservations jsonb; begin
 select to_jsonb(a) into before_approval from public.labor_job_hour_approvals a where id='95000000-0000-4000-8000-000000000010';
 select jsonb_agg(to_jsonb(r)order by id) into before_reservations from public.labor_job_hour_reservations r where approval_id in ('95000000-0000-4000-8000-000000000010','95000000-0000-4000-8000-000000000013');
 begin perform pg_temp.record_resolution(p_actor=>'95000000-0000-4000-8000-000000000002');raise exception 'worker recorded resolution';exception when others then if sqlerrm<>'forbidden' then raise;end if;end;
 begin perform pg_temp.record_resolution(p_hash=>repeat('f',64));raise exception 'wrong snapshot resolved';exception when others then if sqlerrm<>'labor_approval_stale' then raise;end if;end;
 begin perform pg_temp.record_resolution(p_reason=>'short');raise exception 'missing reason accepted';exception when others then if sqlerrm<>'labor_correction_invalid_request' then raise;end if;end;
 begin perform public.record_labor_manual_correction('95000000-0000-4000-8000-000000000010',gen_random_uuid(),repeat('a',64),'95000000-0000-4000-8000-000000000001','TEST valid reason',' ','TEST valid evidence');raise exception 'missing reference accepted';exception when others then if sqlerrm<>'labor_correction_invalid_request' then raise;end if;end;
 begin perform public.record_labor_manual_correction('95000000-0000-4000-8000-000000000010',gen_random_uuid(),repeat('a',64),'95000000-0000-4000-8000-000000000001','TEST valid reason','TEST REF',' ');raise exception 'missing evidence accepted';exception when others then if sqlerrm<>'labor_correction_invalid_request' then raise;end if;end;
 begin perform pg_temp.record_resolution(p_approval=>'95000000-0000-4000-8000-000000000011',p_hash=>repeat('c',64));raise exception 'undispatched approval resolved';exception when others then if sqlerrm<>'labor_approval_invalid_status' then raise;end if;end;
 begin perform pg_temp.record_resolution(p_approval=>'95000000-0000-4000-8000-000000000012',p_hash=>repeat('d',64));raise exception 'live dispatch resolved';exception when others then if sqlerrm<>'labor_approval_dispatch_busy' then raise;end if;end;
 saved:=pg_temp.record_resolution(); repeated:=pg_temp.record_resolution();
 if saved is distinct from repeated then raise exception 'retry duplicated resolution';end if;
 if (select count(*)from public.labor_manual_corrections where approval_id='95000000-0000-4000-8000-000000000010')<>1 then raise exception 'resolution not idempotent';end if;
 begin perform pg_temp.record_resolution(p_reason=>'TEST different correction details');raise exception 'idempotency key changed evidence';exception when others then if sqlerrm<>'labor_correction_conflict' then raise;end if;end;
 perform pg_temp.record_resolution(p_approval=>'95000000-0000-4000-8000-000000000013',p_request=>'95000000-0000-4000-8000-000000000021',p_hash=>repeat('e',64));
 if before_approval is distinct from (select to_jsonb(a)from public.labor_job_hour_approvals a where id='95000000-0000-4000-8000-000000000010') then raise exception 'original sent approval changed';end if;
 if before_reservations is distinct from (select jsonb_agg(to_jsonb(r)order by id)from public.labor_job_hour_reservations r where approval_id in ('95000000-0000-4000-8000-000000000010','95000000-0000-4000-8000-000000000013')) then raise exception 'resolution released source time';end if;
 if (select status from public.labor_job_hour_approvals where id='95000000-0000-4000-8000-000000000013')<>'reconciliation_required' then raise exception 'attestation became verified provider evidence';end if;
 if not exists(select 1 from public.labor_job_hour_events where approval_id='95000000-0000-4000-8000-000000000010' and event='manual_resolution_recorded' and details->>'attestationOnly'='true')then raise exception 'resolution audit missing';end if;
 if jsonb_array_length(public.read_labor_manual_corrections('95000000-0000-4000-8000-000000000010','95000000-0000-4000-8000-000000000001'))<>1 then raise exception 'history missing';end if;
 begin update public.labor_manual_corrections set reason='TEST changed evidence';raise exception 'resolution mutable';exception when insufficient_privilege then null;end;
 begin delete from public.labor_manual_corrections;raise exception 'resolution deletable';exception when insufficient_privilege then null;end;
 update public.profiles set disabled=true where id='95000000-0000-4000-8000-000000000001';
 begin perform pg_temp.record_resolution();raise exception 'disabled manager replayed correction';exception when others then if sqlerrm<>'unauthenticated' then raise;end if;end;
 begin perform public.read_labor_manual_corrections('95000000-0000-4000-8000-000000000010','95000000-0000-4000-8000-000000000001');raise exception 'disabled manager read correction';exception when others then if sqlerrm<>'unauthenticated' then raise;end if;end;
end; $$;
reset role;
rollback;
