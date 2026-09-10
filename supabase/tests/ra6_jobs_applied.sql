-- RA-43: rollback-only catalog, lease, mapping, atomicity, and access regressions.
-- Run against a disposable local database after all migrations; no provider calls.
begin;

insert into auth.users(id,aud,role,email) values
 ('64300000-0000-4000-8000-000000000001','authenticated','authenticated','ra6jobs-worker@example.invalid'),
 ('64300000-0000-4000-8000-000000000002','authenticated','authenticated','ra6jobs-manager@example.invalid'),
 ('64300000-0000-4000-8000-000000000003','authenticated','authenticated','ra6jobs-admin@example.invalid'),
 ('64300000-0000-4000-8000-000000000004','authenticated','authenticated','ra6jobs-disabled-worker@example.invalid'),
 ('64300000-0000-4000-8000-000000000005','authenticated','authenticated','ra6jobs-disabled-admin@example.invalid'),
 ('64300000-0000-4000-8000-000000000006','authenticated','authenticated','ra6jobs-worker-two@example.invalid');
update public.profiles set role='manager' where id='64300000-0000-4000-8000-000000000002';
update public.profiles set role='admin' where id in ('64300000-0000-4000-8000-000000000003','64300000-0000-4000-8000-000000000005');
update public.profiles set disabled=true where id in ('64300000-0000-4000-8000-000000000004','64300000-0000-4000-8000-000000000005');
insert into public.manager_job_catalog(id,label,source,active,unavailable)
 values('ra6jobs-manual','Existing manual test job',null,true,false);
update public.housecall_sync_state set lease_token=null,lease_expires_at=null,
 last_success_at=null,last_full_sync_at=null,last_error=null,last_count=0 where id;

do $$
declare role_name text; signature text; table_name text;
begin
 foreach table_name in array array['housecall_sync_state','housecall_employee_mappings','manager_job_catalog'] loop
  if not (select c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=table_name) then
   raise exception 'RA6 catalog table lacks RLS: %',table_name;
  end if;
 end loop;
 foreach signature in array array[
  'public.claim_housecall_job_sync(integer)',
  'public.finish_housecall_job_sync(uuid,timestamp with time zone,jsonb,boolean,text[],text[])',
  'public.fail_housecall_job_sync(uuid,text)',
  'public.configure_housecall_employee_mapping(uuid,text,uuid)'
 ] loop
  foreach role_name in array array['anon','authenticated'] loop
   if has_function_privilege(role_name,signature,'EXECUTE') then raise exception 'RA6 service RPC exposed: % to %',signature,role_name;end if;
  end loop;
  if not has_function_privilege('service_role',signature,'EXECUTE') then raise exception 'RA6 service RPC lacks service grant: %',signature;end if;
  if (select prosecdef from pg_proc where oid=signature::regprocedure) then raise exception 'RA6 RPC unexpectedly bypasses invoker permissions: %',signature;end if;
 end loop;
 foreach table_name in array array['housecall_sync_state','housecall_employee_mappings'] loop
  foreach role_name in array array['anon','authenticated'] loop
   if has_table_privilege(role_name,'public.'||table_name,'SELECT,INSERT,UPDATE,DELETE') then raise exception 'RA6 service table exposed: % to %',table_name,role_name;end if;
  end loop;
 end loop;
 if has_table_privilege('authenticated','public.manager_job_catalog','INSERT,UPDATE,DELETE')
  or has_table_privilege('anon','public.manager_job_catalog','SELECT,INSERT,UPDATE,DELETE') then raise exception 'catalog mutation/anon grant exposed';end if;
end;$$;

set local role service_role;
do $$
declare
 worker_id uuid:='64300000-0000-4000-8000-000000000001';
 manager_id uuid:='64300000-0000-4000-8000-000000000002';
 admin_id uuid:='64300000-0000-4000-8000-000000000003';
 disabled_worker_id uuid:='64300000-0000-4000-8000-000000000004';
 disabled_admin_id uuid:='64300000-0000-4000-8000-000000000005';
 worker_two_id uuid:='64300000-0000-4000-8000-000000000006';
 token uuid; old_token uuid; claimed jsonb; payload jsonb; bad jsonb;
 started_at timestamptz; previous_success timestamptz; previous_full timestamptz;
 catalog_before jsonb; catalog_after jsonb; result_count integer; n integer;
 a jsonb:='{"id":"ra6jobs-a","label":"Same synthetic customer label","customer":"RA6 Synthetic Customer","customer_id":"ra6jobs-customer","job_number":"11","status":"scheduled","active":true,"unavailable":false,"assigned_employee_ids":["ra6jobs-employee-1","ra6jobs-employee-2","ra6jobs-employee-3","ra6jobs-unknown-employee"],"service_address":"Synthetic test address","provider_updated_at":"2026-09-09T12:00:00Z"}';
 b jsonb:='{"id":"ra6jobs-b","label":"Same synthetic customer label","customer":"RA6 Synthetic Customer","job_number":"12","status":"scheduled","active":true,"unavailable":false,"assigned_employee_ids":[]}';
begin
 -- The service caller must still identify an active administrator for mappings.
 begin perform public.configure_housecall_employee_mapping(manager_id,'ra6jobs-employee-1',worker_id);raise exception 'manager mapping accepted';exception when others then if sqlerrm<>'forbidden' then raise;end if;end;
 begin perform public.configure_housecall_employee_mapping(worker_id,'ra6jobs-employee-1',worker_id);raise exception 'worker mapping accepted';exception when others then if sqlerrm<>'forbidden' then raise;end if;end;
 begin perform public.configure_housecall_employee_mapping(disabled_admin_id,'ra6jobs-employee-1',worker_id);raise exception 'disabled administrator mapping accepted';exception when others then if sqlerrm<>'unauthenticated' then raise;end if;end;
 begin perform public.configure_housecall_employee_mapping(null,'ra6jobs-employee-1',worker_id);raise exception 'missing actor mapping accepted';exception when others then if sqlerrm<>'unauthenticated' then raise;end if;end;
 begin perform public.configure_housecall_employee_mapping(admin_id,'ra6jobs-invalid/employee',worker_id);raise exception 'invalid employee ID accepted';exception when others then if sqlerrm<>'invalid_request' then raise;end if;end;
 begin perform public.configure_housecall_employee_mapping(admin_id,'ra6jobs-employee-1',disabled_worker_id);raise exception 'disabled mapping target accepted';exception when others then if sqlerrm<>'invalid_request' then raise;end if;end;
 begin perform public.configure_housecall_employee_mapping(admin_id,'ra6jobs-employee-1','64300000-0000-4000-8000-000000000099');raise exception 'unknown mapping target accepted';exception when others then if sqlerrm<>'invalid_request' then raise;end if;end;
 if exists(select 1 from public.housecall_employee_mappings where employee_id like 'ra6jobs-%') then raise exception 'invalid mapping partially committed';end if;
 perform public.configure_housecall_employee_mapping(admin_id,'ra6jobs-employee-1',worker_id);
 perform public.configure_housecall_employee_mapping(admin_id,'ra6jobs-employee-2',worker_id);
 perform public.configure_housecall_employee_mapping(admin_id,'ra6jobs-employee-3',worker_two_id);
 if not exists(select 1 from public.housecall_employee_mappings where employee_id='ra6jobs-employee-1' and user_id=worker_id and updated_by=admin_id) then raise exception 'mapping actor/target missing';end if;

 -- A live claim is exclusive; only an expired claim can be replaced.
 foreach n in array array[0,29,301] loop
  begin perform public.claim_housecall_job_sync(n);raise exception 'unbounded sync lease accepted';exception when others then if sqlerrm<>'invalid_request' then raise;end if;end;
 end loop;
 begin perform public.claim_housecall_job_sync(null);raise exception 'null lease accepted';exception when others then if sqlerrm<>'invalid_request' then raise;end if;end;
 claimed:=public.claim_housecall_job_sync(180);token:=(claimed->>'lease_token')::uuid;
 if token is null or (claimed->>'lease_expires_at')::timestamptz<=clock_timestamp() then raise exception 'valid lease missing';end if;
 if public.claim_housecall_job_sync(180) is not null then raise exception 'live sync lease stolen';end if;
 payload:=jsonb_build_array(a,b);
 started_at:=clock_timestamp();
 begin perform public.finish_housecall_job_sync(gen_random_uuid(),started_at,payload,true);raise exception 'foreign lease finished';exception when others then if sqlerrm<>'conflict' then raise;end if;end;
 update public.housecall_sync_state set lease_expires_at=clock_timestamp()-interval '1 second' where id;
 begin perform public.finish_housecall_job_sync(token,started_at,payload,true);raise exception 'expired lease finished';exception when others then if sqlerrm<>'conflict' then raise;end if;end;
 old_token:=token;
 claimed:=public.claim_housecall_job_sync(180);token:=(claimed->>'lease_token')::uuid;
 if token is null or token=old_token then raise exception 'expired lease not replaced';end if;
 perform public.fail_housecall_job_sync(old_token,'provider_timeout');
 if (select lease_token from public.housecall_sync_state where id) is distinct from token then raise exception 'stale failure cleared replacement lease';end if;
 begin perform public.finish_housecall_job_sync(old_token,started_at,payload,true);raise exception 'stale lease finished';exception when others then if sqlerrm<>'conflict' then raise;end if;end;

 -- Invalid second rows must undo earlier upserts and retain the active claim.
 foreach bad in array array[
  jsonb_build_array(a,jsonb_set(b,'{active}','"true"')),
  jsonb_build_array(a,jsonb_set(b,'{assigned_employee_ids}','{}')),
  jsonb_build_array(a,jsonb_set(b,'{assigned_employee_ids}','[42]')),
  jsonb_build_array(a,jsonb_set(b,'{assigned_employee_ids}','[{}]')),
  jsonb_build_array(a,jsonb_set(b,'{assigned_employee_ids}','[null]')),
  jsonb_build_array(a,jsonb_set(b,'{assigned_employee_ids}','["invalid/employee"]')),
  jsonb_build_array(a,jsonb_set(b,'{unavailable}','null')),
  jsonb_build_array(a,jsonb_set(b,'{id}','"invalid/job"')),
  jsonb_build_array(a,jsonb_set(b,'{id}','42')),
  jsonb_build_array(a,jsonb_set(b,'{label}','""')),
  jsonb_build_array(a,jsonb_set(b,'{label}','"   "')),
  jsonb_build_array(a,jsonb_set(b,'{label}','{}')),
  jsonb_build_array(a,a),
  '{}'::jsonb
 ] loop
  begin perform public.finish_housecall_job_sync(token,started_at,bad,true);raise exception 'invalid sync payload accepted';exception when others then if sqlerrm<>'invalid_request' then raise;end if;end;
  if exists(select 1 from public.manager_job_catalog where id in ('ra6jobs-a','ra6jobs-b')) then raise exception 'invalid sync partially committed';end if;
  if (select lease_token from public.housecall_sync_state where id) is distinct from token then raise exception 'invalid sync lost live lease';end if;
  if (select last_success_at from public.housecall_sync_state where id) is not null then raise exception 'invalid sync advanced watermark';end if;
 end loop;
 begin perform public.finish_housecall_job_sync(token,started_at,null,true);raise exception 'null job payload accepted';exception when others then if sqlerrm<>'invalid_request' then raise;end if;end;
 begin perform public.finish_housecall_job_sync(token,started_at,payload,null);raise exception 'null full flag accepted';exception when others then if sqlerrm<>'invalid_request' then raise;end if;end;
 begin perform public.finish_housecall_job_sync(token,clock_timestamp()-interval '11 minutes',payload,true);raise exception 'too-old scan accepted';exception when others then if sqlerrm<>'invalid_request' then raise;end if;end;
 begin perform public.finish_housecall_job_sync(token,clock_timestamp()+interval '2 minutes',payload,true);raise exception 'future scan accepted';exception when others then if sqlerrm<>'invalid_request' then raise;end if;end;

 result_count:=public.finish_housecall_job_sync(token,started_at,payload,true);
 if result_count<>2 then raise exception 'successful scan count incorrect';end if;
 if (select count(*) from public.manager_job_catalog where id in ('ra6jobs-a','ra6jobs-b') and label='Same synthetic customer label')<>2 then raise exception 'distinct job IDs collapsed by label';end if;
 if not exists(select 1 from public.manager_job_catalog where id='ra6jobs-a' and source='housecall' and synced_at=started_at and customer_id='ra6jobs-customer' and not unavailable and active) then raise exception 'normalized job context missing';end if;
 if not exists(select 1 from public.manager_job_catalog where id='ra6jobs-a' and jsonb_array_length(assigned_worker_ids)=2 and assigned_worker_ids ? worker_id::text and assigned_worker_ids ? worker_two_id::text) then raise exception 'mapping not applied or duplicate worker IDs retained';end if;
 if not exists(select 1 from public.manager_job_catalog where id='ra6jobs-b' and assigned_worker_ids='[]'::jsonb) then raise exception 'empty employee assignment inferred a worker';end if;
 if not exists(select 1 from public.housecall_sync_state where id and last_success_at=started_at and last_full_sync_at=started_at and last_count=2 and lease_token is null and lease_expires_at is null and last_error is null) then raise exception 'success state not atomic';end if;

 -- Mapping changes immediately recalculate known catalog assignments.
 perform public.configure_housecall_employee_mapping(admin_id,'ra6jobs-employee-3',worker_id);
 if not exists(select 1 from public.manager_job_catalog where id='ra6jobs-a' and assigned_worker_ids=jsonb_build_array(worker_id::text)) then raise exception 'mapping update left stale/duplicate worker assignment';end if;

 -- Failed scans retain all rows, prior timestamps, and totals.
 select jsonb_agg(to_jsonb(c) order by id) into catalog_before from public.manager_job_catalog c where id like 'ra6jobs-%';
 select last_success_at,last_full_sync_at into previous_success,previous_full from public.housecall_sync_state where id;
 claimed:=public.claim_housecall_job_sync(180);token:=(claimed->>'lease_token')::uuid;
 perform public.fail_housecall_job_sync(token,'provider_timeout');
 select jsonb_agg(to_jsonb(c) order by id) into catalog_after from public.manager_job_catalog c where id like 'ra6jobs-%';
 if catalog_before is distinct from catalog_after then raise exception 'failed scan changed catalog';end if;
 if not exists(select 1 from public.housecall_sync_state where id and last_error='provider_timeout' and lease_token is null and lease_expires_at is null and last_success_at=previous_success and last_full_sync_at=previous_full and last_count=2) then raise exception 'failure cleared prior success or retained lease';end if;
 claimed:=public.claim_housecall_job_sync(180);token:=(claimed->>'lease_token')::uuid;
 perform public.fail_housecall_job_sync(token,'raw provider error with private details');
 if (select last_error from public.housecall_sync_state where id)<>'sync_failed' then raise exception 'raw provider failure persisted';end if;

  -- Partial scans cannot turn absence into deletion; full scans can.
  claimed:=public.claim_housecall_job_sync(180);token:=(claimed->>'lease_token')::uuid;
  started_at:=clock_timestamp();
 begin perform public.finish_housecall_job_sync(token,started_at,jsonb_build_array(a),false,array['invalid/id']);raise exception 'invalid observed ID accepted';exception when others then if sqlerrm<>'invalid_request' then raise;end if;end;
 begin perform public.finish_housecall_job_sync(token,started_at,jsonb_build_array(a),false,array['ra6jobs-b']);raise exception 'payload absent from observed set accepted';exception when others then if sqlerrm<>'invalid_request' then raise;end if;end;
 begin perform public.finish_housecall_job_sync(token,started_at,jsonb_build_array(a),false,array[null::text]);raise exception 'null observed ID accepted';exception when others then if sqlerrm<>'invalid_request' then raise;end if;end;
 perform public.finish_housecall_job_sync(token,started_at,jsonb_build_array(jsonb_set(a,'{job_number}','"13"')),false,array['ra6jobs-a','ra6jobs-b']);
 if not exists(select 1 from public.manager_job_catalog where id='ra6jobs-b' and synced_at=started_at and job_number='12') then raise exception 'observed unchanged job did not refresh freshness without replacing context';end if;
 if not exists(select 1 from public.manager_job_catalog where id='ra6jobs-b' and active and not unavailable) then raise exception 'partial scan invalidated unseen job';end if;
 if (select last_full_sync_at from public.housecall_sync_state where id) is distinct from previous_full then raise exception 'partial scan advanced full-sync watermark';end if;
 claimed:=public.claim_housecall_job_sync(180);token:=(claimed->>'lease_token')::uuid;
 perform public.finish_housecall_job_sync(token,clock_timestamp(),jsonb_build_array(a),true);
 if not exists(select 1 from public.manager_job_catalog where id='ra6jobs-b' and not active and unavailable) then raise exception 'full scan failed to invalidate missing HCP job';end if;
 if not exists(select 1 from public.manager_job_catalog where id='ra6jobs-manual' and active and not unavailable and source is null) then raise exception 'HCP scan invalidated other-source job';end if;

 -- A returning job becomes available again; a now-disabled profile is not mapped.
 update public.profiles set disabled=true where id=worker_id;
 claimed:=public.claim_housecall_job_sync(180);token:=(claimed->>'lease_token')::uuid;
 perform public.finish_housecall_job_sync(token,clock_timestamp(),payload,true);
 if not exists(select 1 from public.manager_job_catalog where id='ra6jobs-b' and active and not unavailable) then raise exception 'returning job remained unavailable';end if;
 if not exists(select 1 from public.manager_job_catalog where id='ra6jobs-a' and assigned_worker_ids='[]'::jsonb) then raise exception 'disabled profile retained synced assignment';end if;
 update public.profiles set disabled=false where id=worker_id;
end;$$;
reset role;

set local role anon;
do $$begin
 begin perform count(*) from public.manager_job_catalog;raise exception 'anon read catalog';exception when insufficient_privilege then null;end;
 begin perform public.claim_housecall_job_sync(180);raise exception 'anon claimed sync';exception when insufficient_privilege then null;end;
end;$$;
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub','64300000-0000-4000-8000-000000000001',true);
do $$begin
 if exists(select 1 from public.manager_job_catalog where id like 'ra6jobs-%') then raise exception 'worker catalog RLS leak';end if;
 begin perform count(*) from public.housecall_sync_state;raise exception 'worker read private sync state';exception when insufficient_privilege then null;end;
 begin perform count(*) from public.housecall_employee_mappings;raise exception 'worker read employee mappings';exception when insufficient_privilege then null;end;
 begin perform public.configure_housecall_employee_mapping('64300000-0000-4000-8000-000000000003','ra6jobs-employee-1','64300000-0000-4000-8000-000000000001');raise exception 'worker spoofed admin through service RPC';exception when insufficient_privilege then null;end;
end;$$;
select set_config('request.jwt.claim.sub','64300000-0000-4000-8000-000000000002',true);
do $$begin
 if (select count(*) from public.manager_job_catalog where id like 'ra6jobs-%')<>3 then raise exception 'manager cannot read normalized job catalog';end if;
 begin update public.manager_job_catalog set label='Unexpected mutation' where id='ra6jobs-a';raise exception 'manager directly mutated job catalog';exception when insufficient_privilege then null;end;
end;$$;
select set_config('request.jwt.claim.sub','64300000-0000-4000-8000-000000000003',true);
do $$begin
 if (select count(*) from public.manager_job_catalog where id like 'ra6jobs-%')<>3 then raise exception 'admin cannot read job catalog';end if;
 begin perform public.claim_housecall_job_sync(180);raise exception 'browser admin bypassed service sync route';exception when insufficient_privilege then null;end;
end;$$;
select set_config('request.jwt.claim.sub','64300000-0000-4000-8000-000000000005',true);
do $$begin
 if exists(select 1 from public.manager_job_catalog where id like 'ra6jobs-%') then raise exception 'disabled administrator catalog RLS leak';end if;
end;$$;
reset role;

rollback;
