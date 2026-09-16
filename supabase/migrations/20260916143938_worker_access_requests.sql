create schema if not exists private;
revoke all on schema private from public,anon;
grant usage on schema private to authenticated;

-- Existing accounts keep their access. New accounts default to pending; user metadata cannot grant roles.
alter table public.profiles
 add column full_name text not null default '' check (length(full_name)<=120),
 add column email text not null default '' check (length(email)<=254),
 add column phone text not null default '' check (length(phone)<=40),
 add column access_status text not null default 'approved' check(access_status in ('pending','approved','rejected')),
 add column access_version integer not null default 0,
 add column access_updated_at timestamptz not null default now(),
 add constraint inactive_requests check(access_status='approved' or (disabled and role='worker'));
update public.profiles p set email=left(coalesce(u.email,''),254),
 full_name=left(coalesce(u.raw_user_meta_data->>'full_name',''),120) from auth.users u where u.id=p.id;
alter table public.profiles alter column disabled set default true;
create index profiles_access_queue_idx on public.profiles(access_status,created_at,id);

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 insert into public.profiles(id,role,disabled,access_status,full_name,email,phone)
 values(new.id,'worker',not coalesce(new.raw_app_meta_data @> '{"svl_access_approved":true}',false),
 case when new.raw_app_meta_data @> '{"svl_access_approved":true}' then 'approved' else 'pending' end,
 left(coalesce(new.raw_user_meta_data->>'full_name',''),120),left(coalesce(new.email,''),254),
 left(coalesce(new.raw_user_meta_data->>'phone',''),40));
 return new;
end;$$;
revoke all on function public.handle_new_user() from public,anon,authenticated,service_role;
-- Keep the contact email current when an administrator uses Supabase Auth directly.
create function private.sync_profile_email() returns trigger language plpgsql security definer set search_path='' as $$
begin update public.profiles set email=left(coalesce(new.email,''),254) where id=new.id; return new; end;$$;
revoke all on function private.sync_profile_email() from public,anon,authenticated,service_role;
create trigger sync_profile_email after update of email on auth.users for each row execute function private.sync_profile_email();

create table public.workspace_access_events (
 id uuid primary key default gen_random_uuid(),
 actor_id uuid references public.profiles(id) on delete set null,
 target_id uuid references public.profiles(id) on delete set null,
 action text not null,
 previous_state jsonb not null,
 resulting_state jsonb not null,
 created_at timestamptz not null default now()
);
create index workspace_access_events_actor_idx on public.workspace_access_events(actor_id);
create index workspace_access_events_target_idx on public.workspace_access_events(target_id,created_at);
alter table public.workspace_access_events enable row level security;
revoke all on public.workspace_access_events from anon,authenticated;
grant select on public.workspace_access_events to authenticated;
grant all on public.workspace_access_events to service_role;
create policy access_audit_admin on public.workspace_access_events for select to authenticated using((select public.current_user_role())='admin');

-- Called as the signed-in user. Recheck role inside the same serialized transaction as the change.
create function private.manage_workspace_user(p_target_id uuid,p_action text,p_expected_version integer,p_role text default null)
returns void language plpgsql security definer set search_path='' as $$
declare actor public.profiles%rowtype; target public.profiles%rowtype; before_state jsonb;
begin
 perform pg_advisory_xact_lock(714221907);
 select * into actor from public.profiles where id=auth.uid() for update;
 if actor.id is null or actor.disabled or actor.role not in ('manager','admin') then raise exception 'forbidden' using errcode='42501'; end if;
 select * into target from public.profiles where id=p_target_id for update;
 if target.id is null or (actor.role='manager' and target.role<>'worker') or actor.id=target.id then raise exception 'forbidden' using errcode='42501'; end if;
 if p_expected_version is null or target.access_version<>p_expected_version then raise exception 'account_changed'; end if;
 before_state:=jsonb_build_object('role',target.role,'disabled',target.disabled,'status',target.access_status);
 if p_action='approve' and target.access_status='pending' then target.access_status:='approved'; target.disabled:=false;
 elsif p_action='reject' and target.access_status='pending' then target.access_status:='rejected'; target.disabled:=true;
 elsif p_action='disable' and target.access_status='approved' and not target.disabled then target.disabled:=true;
 elsif p_action='enable' and target.access_status='approved' and target.disabled then target.disabled:=false;
 elsif p_action='role' and actor.role='admin' and target.access_status='approved' and p_role in ('worker','manager','admin') then target.role:=p_role;
 else raise exception 'invalid_account_action'; end if;
 if (target.disabled or target.role<>'admin') and before_state->>'role'='admin'
  and not exists(select 1 from public.profiles where role='admin' and not disabled and id<>target.id)
 then raise exception 'last_admin'; end if;
 update public.profiles set role=target.role,disabled=target.disabled,access_status=target.access_status,
  access_version=access_version+1,access_updated_at=clock_timestamp() where id=target.id;
 insert into public.workspace_access_events(actor_id,target_id,action,previous_state,resulting_state)
 values(actor.id,target.id,p_action,before_state,jsonb_build_object('role',target.role,'disabled',target.disabled,'status',target.access_status));
end;$$;
revoke all on function private.manage_workspace_user(uuid,text,integer,text) from public,anon,service_role;
grant execute on function private.manage_workspace_user(uuid,text,integer,text) to authenticated;
create function public.manage_workspace_user(p_target_id uuid,p_action text,p_expected_version integer,p_role text default null)
returns void language sql security invoker set search_path='' as $$
 select private.manage_workspace_user(p_target_id,p_action,p_expected_version,p_role);
$$;
revoke all on function public.manage_workspace_user(uuid,text,integer,text) from public,anon,service_role;
grant execute on function public.manage_workspace_user(uuid,text,integer,text) to authenticated;

-- Bounded public registration; only the server can consume a bucket. No emails or IP addresses stored here.
create table public.access_request_limits (bucket text primary key, window_start timestamptz not null, attempts integer not null);
create index access_request_limits_window_idx on public.access_request_limits(window_start);
alter table public.access_request_limits enable row level security;
revoke all on public.access_request_limits from public,anon,authenticated;
grant all on public.access_request_limits to service_role;
create function public.consume_access_request_limit(p_bucket text,p_limit integer) returns boolean
language plpgsql security invoker set search_path='' as $$
declare used integer;
begin
 if length(p_bucket)<>64 or p_limit<1 or p_limit>20 then raise exception 'invalid_request'; end if;
 delete from public.access_request_limits where window_start<now()-interval '2 hours';
 insert into public.access_request_limits(bucket,window_start,attempts) values(p_bucket,now(),1)
 on conflict(bucket) do update set
 attempts=case when access_request_limits.window_start<now()-interval '1 hour' then 1 else least(access_request_limits.attempts+1,21) end,
 window_start=case when access_request_limits.window_start<now()-interval '1 hour' then now() else access_request_limits.window_start end
 returning attempts into used;
 return used<=p_limit;
end;$$;
revoke all on function public.consume_access_request_limit(text,integer) from public,anon,authenticated;
grant execute on function public.consume_access_request_limit(text,integer) to service_role;
