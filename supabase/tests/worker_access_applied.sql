begin;
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('91000000-0000-4000-8000-000000000001','authenticated','authenticated','pending@example.invalid','{}','{"full_name":"New Worker","role":"admin","svl_access_approved":true}'),
 ('91000000-0000-4000-8000-000000000002','authenticated','authenticated','manager@example.invalid','{"svl_access_approved":true}','{}'),
 ('91000000-0000-4000-8000-000000000003','authenticated','authenticated','admin@example.invalid','{"svl_access_approved":true}','{}'),
 ('91000000-0000-4000-8000-000000000004','authenticated','authenticated','other-pending@example.invalid','{}','{}');
update public.profiles set role='manager' where id='91000000-0000-4000-8000-000000000002';
update public.profiles set role='admin' where id='91000000-0000-4000-8000-000000000003';
do $$ begin
 if not exists(select 1 from public.profiles where id='91000000-0000-4000-8000-000000000001' and role='worker' and disabled and access_status='pending' and full_name='New Worker') then raise exception 'new worker bypassed approval'; end if;
 if has_table_privilege('authenticated','public.profiles','UPDATE') or has_function_privilege('anon','public.manage_workspace_user(uuid,text,integer,text)','EXECUTE') or has_function_privilege('authenticated','public.consume_access_request_limit(text,integer)','EXECUTE') then raise exception 'account mutation privilege leaked'; end if;
end;$$;
set local role authenticated;
select set_config('request.jwt.claim.sub','91000000-0000-4000-8000-000000000001',true);
do $$ begin
 if public.caller_is_active() or public.current_user_role() is not null then raise exception 'pending worker has application access'; end if;
 begin perform public.manage_workspace_user('91000000-0000-4000-8000-000000000001','approve',0); raise exception 'self approval allowed'; exception when insufficient_privilege then null; end;
end;$$;
select set_config('request.jwt.claim.sub','91000000-0000-4000-8000-000000000002',true);
select public.manage_workspace_user('91000000-0000-4000-8000-000000000001','approve',0);
do $$ begin
 begin perform public.manage_workspace_user('91000000-0000-4000-8000-000000000001','reject',0); raise exception 'stale approval allowed'; exception when others then if sqlerrm<>'account_changed' then raise; end if; end;
 begin perform public.manage_workspace_user('91000000-0000-4000-8000-000000000001','role',1,'admin'); raise exception 'manager promoted a user'; exception when others then if sqlerrm<>'invalid_account_action' then raise; end if; end;
 begin perform public.manage_workspace_user('91000000-0000-4000-8000-000000000003','disable',0); raise exception 'manager disabled admin'; exception when insufficient_privilege then null; end;
end;$$;
select set_config('request.jwt.claim.sub','91000000-0000-4000-8000-000000000001',true);
do $$ begin if not public.caller_is_active() or public.current_user_role()<>'worker' then raise exception 'approved worker unavailable'; end if; end;$$;
select set_config('request.jwt.claim.sub','91000000-0000-4000-8000-000000000002',true);
select public.manage_workspace_user('91000000-0000-4000-8000-000000000001','disable',1);
select public.manage_workspace_user('91000000-0000-4000-8000-000000000004','reject',0);
select set_config('request.jwt.claim.sub','91000000-0000-4000-8000-000000000001',true);
do $$ begin if public.caller_is_active() then raise exception 'disabled worker kept access with old JWT'; end if; end;$$;
select set_config('request.jwt.claim.sub','91000000-0000-4000-8000-000000000003',true);
select public.manage_workspace_user('91000000-0000-4000-8000-000000000001','enable',2);
select public.manage_workspace_user('91000000-0000-4000-8000-000000000001','role',3,'manager');
select public.manage_workspace_user('91000000-0000-4000-8000-000000000001','role',4,'admin');
select public.manage_workspace_user('91000000-0000-4000-8000-000000000001','role',5,'worker');
do $$ begin
 begin perform public.manage_workspace_user('91000000-0000-4000-8000-000000000003','disable',0); raise exception 'admin disabled own account'; exception when insufficient_privilege then null; end;
 if (select count(*) from public.workspace_access_events where target_id in ('91000000-0000-4000-8000-000000000001','91000000-0000-4000-8000-000000000004'))<>7 then raise exception 'missing account audit events'; end if;
end;$$;
reset role;
set local role service_role;
do $$ begin
 if not public.consume_access_request_limit(repeat('a',64),1) or public.consume_access_request_limit(repeat('a',64),1) then raise exception 'registration throttle failed'; end if;
end;$$;
rollback;
