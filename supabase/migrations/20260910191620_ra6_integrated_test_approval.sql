-- Explicit, bounded standing authorization for the integrated test environment.
-- No session, user, job, or approval is seeded by this migration.
create table public.housecall_test_sessions (
 id uuid primary key default gen_random_uuid(),
 authorized_by uuid not null references auth.users(id),
 owner_ids uuid[] not null check(cardinality(owner_ids) between 1 and 10),
 reviewer_ids uuid[] not null check(cardinality(reviewer_ids) between 1 and 10),
 job_bindings jsonb not null check(jsonb_typeof(job_bindings)='object'),
 reason text not null check(length(btrim(reason)) between 1 and 2000),
 created_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null,
 revoked_at timestamptz,
 revoked_by uuid references auth.users(id),
 revocation_reason text,
 max_receipts integer not null check(max_receipts between 1 and 25),
 max_writes integer not null check(max_writes between 1 and 200),
 max_total_cents integer not null check(max_total_cents between 1 and 100000),
 max_receipt_cents integer not null check(max_receipt_cents between 1 and 50000),
 reserved_receipts integer not null default 0 check(reserved_receipts between 0 and max_receipts),
 reserved_writes integer not null default 0 check(reserved_writes between 0 and max_writes),
 reserved_cents integer not null default 0 check(reserved_cents between 0 and max_total_cents),
 check(expires_at>created_at and expires_at<=created_at+interval '24 hours')
);
create index housecall_test_sessions_actor_idx on public.housecall_test_sessions(authorized_by);
create index housecall_test_sessions_revoker_idx on public.housecall_test_sessions(revoked_by) where revoked_by is not null;
alter table public.housecall_test_sessions enable row level security;
revoke all on public.housecall_test_sessions from public,anon,authenticated;
grant select,insert,update on public.housecall_test_sessions to service_role;
alter table public.housecall_write_approvals add column test_session_id uuid references public.housecall_test_sessions(id);
create index housecall_write_approvals_session_idx on public.housecall_write_approvals(test_session_id) where test_session_id is not null;
grant update(test_session_id) on public.housecall_write_approvals to service_role;

create function public.guard_housecall_test_session() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if (to_jsonb(new)-array['reserved_receipts','reserved_writes','reserved_cents','revoked_at','revoked_by','revocation_reason'])
  is distinct from (to_jsonb(old)-array['reserved_receipts','reserved_writes','reserved_cents','revoked_at','revoked_by','revocation_reason'])
  or new.reserved_receipts<old.reserved_receipts or new.reserved_writes<old.reserved_writes or new.reserved_cents<old.reserved_cents
  or (old.revoked_at is not null and (new.revoked_at,new.revoked_by,new.revocation_reason) is distinct from (old.revoked_at,old.revoked_by,old.revocation_reason))
  then raise exception 'immutable_test_authorization'; end if;
 return new;
end;$$;
revoke all on function public.guard_housecall_test_session() from public,anon,authenticated;
create trigger housecall_test_session_guard before update on public.housecall_test_sessions
for each row execute function public.guard_housecall_test_session();

create function public.create_housecall_test_session(
 p_actor_id uuid,p_owner_ids uuid[],p_reviewer_ids uuid[],p_job_bindings jsonb,
 p_expires_at timestamptz,p_max_receipts integer,p_max_writes integer,
 p_max_total_cents integer,p_max_receipt_cents integer,p_reason text
) returns uuid language plpgsql security invoker set search_path='' as $$
declare session_id uuid; user_id uuid;
begin
 perform public.require_active_actor(p_actor_id,array['admin']);
 if p_owner_ids is null or p_reviewer_ids is null or array_position(p_owner_ids,null) is not null
  or array_position(p_reviewer_ids,null) is not null or p_job_bindings is null
  or jsonb_typeof(p_job_bindings)<>'object' then raise exception 'invalid_request'; end if;
 if (select count(*) from jsonb_each_text(p_job_bindings)) not between 1 and 20
  or exists(select 1 from jsonb_each_text(p_job_bindings) b
   left join public.manager_job_catalog j on j.id=b.key
   where j.id is null or j.source<>'housecall' or j.unavailable
    or j.customer_id is distinct from b.value or b.value is null or b.value=''
    or j.synced_at is null or j.synced_at<clock_timestamp()-interval '26 hours')
  then raise exception 'test_export_scope'; end if;
 foreach user_id in array p_owner_ids loop
  perform public.require_active_actor(user_id,array['worker']);
 end loop;
 foreach user_id in array p_reviewer_ids loop
  perform public.require_active_actor(user_id,array['manager','admin']);
 end loop;
 insert into public.housecall_test_sessions(authorized_by,owner_ids,reviewer_ids,job_bindings,reason,expires_at,
  max_receipts,max_writes,max_total_cents,max_receipt_cents)
 values(p_actor_id,p_owner_ids,p_reviewer_ids,p_job_bindings,p_reason,p_expires_at,
  p_max_receipts,p_max_writes,p_max_total_cents,p_max_receipt_cents) returning id into session_id;
 -- The immutable session retains its authorizer, scope, budgets, reason and time.
 -- Receipt-level audit is appended by grant_housecall_write_approval on approval.
 return session_id;
end;$$;
revoke all on function public.create_housecall_test_session(uuid,uuid[],uuid[],jsonb,timestamptz,integer,integer,integer,integer,text) from public,anon,authenticated;
grant execute on function public.create_housecall_test_session(uuid,uuid[],uuid[],jsonb,timestamptz,integer,integer,integer,integer,text) to service_role;

-- Review, frozen intent, budget reservation, and exact-hash authorization commit
-- together. Any invalid destination/precision/budget rolls back the approval too.
create function public.manager_review_with_test_export(
 p_session_id uuid,p_receipt_id uuid,p_actor_id uuid,p_version integer,p_extraction_id uuid,
 p_decision text,p_snapshot jsonb,p_reason text default null,p_canonical_id uuid default null
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare session_row public.housecall_test_sessions%rowtype; rec public.receipts%rowtype;
 result jsonb; intent public.housecall_intents%rowtype; grant_result jsonb;
 jobs text[]; writes integer; amount bigint;
begin
 perform public.require_active_actor(p_actor_id,array['manager','admin']);
 select * into rec from public.receipts where id=p_receipt_id for update;
 if p_decision='approve' then
  select * into session_row from public.housecall_test_sessions where id=p_session_id for update;
  if session_row.id is null or session_row.revoked_at is not null or session_row.expires_at<=clock_timestamp()
   or rec.id is null or rec.created_at<session_row.created_at
   or not(rec.owner_user_id=any(session_row.owner_ids)) or not(p_actor_id=any(session_row.reviewer_ids))
   then raise exception 'test_export_scope'; end if;
  perform public.require_active_actor(session_row.authorized_by,array['admin']);
  perform public.require_active_actor(rec.owner_user_id,array['worker']);
 end if;
 result:=public.manager_review_command(p_receipt_id,p_actor_id,p_version,p_extraction_id,p_decision,p_snapshot,p_reason,p_canonical_id);
 if p_decision<>'approve' then return result; end if;
 select * into intent from public.housecall_intents where id=(result->>'intentId')::uuid and receipt_id=p_receipt_id;
 select array_agg(value) into jobs from jsonb_array_elements_text(intent.attachment_job_ids);
 if jobs is null or exists(select 1 from unnest(jobs) job
  left join public.manager_job_catalog j on j.id=job
  where not(session_row.job_bindings ? job) or j.id is null or j.source<>'housecall'
   or j.customer_id is distinct from session_row.job_bindings->>job
   or j.unavailable or j.synced_at is null or j.synced_at<clock_timestamp()-interval '26 hours')
  then raise exception 'test_export_scope'; end if;
 if exists(select 1 from public.housecall_export_steps where intent_id=intent.id and step='job_cost'
  and (payload#>>'{line,qty}')::numeric<>round((payload#>>'{line,qty}')::numeric,2))
  then raise exception 'unsupported_quantity_precision'; end if;
 select count(*),coalesce(sum(case when step='job_cost' then
  round((payload#>>'{line,qty}')::numeric*(payload#>>'{line,unit_cost_cents}')::numeric) else 0 end),0)
 into writes,amount from public.housecall_export_steps where intent_id=intent.id;
 if writes<2 or not exists(select 1 from public.housecall_export_steps where intent_id=intent.id and step='job_cost')
  then raise exception 'test_export_scope'; end if;
 if session_row.reserved_receipts+1>session_row.max_receipts
  or session_row.reserved_writes+writes>session_row.max_writes
  or amount>session_row.max_receipt_cents or session_row.reserved_cents+amount>session_row.max_total_cents
  then raise exception 'test_export_budget'; end if;
 grant_result:=public.grant_housecall_write_approval(session_row.authorized_by,intent.id,intent.payload_hash,jobs,
  session_row.expires_at,writes,'Manager approval within authorized test session '||session_row.id);
 update public.housecall_write_approvals set test_session_id=session_row.id where id=(grant_result->>'id')::uuid;
 update public.housecall_test_sessions set reserved_receipts=reserved_receipts+1,
  reserved_writes=reserved_writes+writes,reserved_cents=reserved_cents+amount where id=session_row.id;
 return result||jsonb_build_object('exportAuthorized',true);
end;$$;
revoke all on function public.manager_review_with_test_export(uuid,uuid,uuid,integer,uuid,text,jsonb,text,uuid) from public,anon,authenticated;
grant execute on function public.manager_review_with_test_export(uuid,uuid,uuid,integer,uuid,text,jsonb,text,uuid) to service_role;

create function public.revoke_housecall_test_session(p_actor_id uuid,p_session_id uuid,p_reason text)
returns void language plpgsql security invoker set search_path='' as $$
begin
 perform public.require_active_actor(p_actor_id,array['admin']);
 if length(btrim(coalesce(p_reason,''))) not between 1 and 2000 then raise exception 'invalid_request'; end if;
 update public.housecall_test_sessions set revoked_at=coalesce(revoked_at,clock_timestamp()),
  revoked_by=coalesce(revoked_by,p_actor_id),revocation_reason=coalesce(revocation_reason,p_reason) where id=p_session_id;
 if not found then raise exception 'invalid_request'; end if;
end;$$;
revoke all on function public.revoke_housecall_test_session(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.revoke_housecall_test_session(uuid,uuid,text) to service_role;

-- Revoking the standing session fences subsequent dispatch, including retries.
-- The old RPC remains service-only; only this wrapper is used by the exporter.
alter function public.consume_housecall_write_approval(uuid,uuid) rename to consume_housecall_write_approval_before_session;
create function public.consume_housecall_write_approval(p_step_id uuid,p_lease_token uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare result jsonb; session_row public.housecall_test_sessions%rowtype;
begin
 result:=public.consume_housecall_write_approval_before_session(p_step_id,p_lease_token);
 if result->>'test_session_id' is not null then
  select * into session_row from public.housecall_test_sessions where id=(result->>'test_session_id')::uuid for share;
  if session_row.id is null or session_row.revoked_at is not null or session_row.expires_at<=clock_timestamp()
   then raise exception 'live_write_approval_required'; end if;
  perform public.require_active_actor(session_row.authorized_by,array['admin']);
 end if;
 return result;
end;$$;
revoke all on function public.consume_housecall_write_approval(uuid,uuid) from public,anon,authenticated;
grant execute on function public.consume_housecall_write_approval(uuid,uuid) to service_role;
