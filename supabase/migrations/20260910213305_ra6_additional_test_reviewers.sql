-- Add an explicitly authorized manager without rewriting an existing test policy.
-- No reviewer or session is seeded. Existing destinations, owners, timestamps and
-- accumulated budgets remain immutable and continue to gate every approval.
create table public.housecall_test_reviewer_grants (
 session_id uuid not null references public.housecall_test_sessions(id),
 reviewer_id uuid not null references auth.users(id),
 authorized_by uuid not null references auth.users(id),
 reason text not null check(length(btrim(reason)) between 1 and 2000),
 created_at timestamptz not null default clock_timestamp(),
 primary key(session_id,reviewer_id)
);
create index housecall_test_reviewer_grants_reviewer_idx on public.housecall_test_reviewer_grants(reviewer_id);
create index housecall_test_reviewer_grants_authorizer_idx on public.housecall_test_reviewer_grants(authorized_by);
alter table public.housecall_test_reviewer_grants enable row level security;
revoke all on public.housecall_test_reviewer_grants from public,anon,authenticated,service_role;
grant select,insert on public.housecall_test_reviewer_grants to service_role;
create trigger housecall_test_reviewer_grants_append_only before update or delete
 on public.housecall_test_reviewer_grants for each row execute function public.reject_mutation();

create function public.authorize_housecall_test_reviewer(
 p_actor_id uuid,p_session_id uuid,p_reviewer_id uuid,p_reason text
) returns void language plpgsql security invoker set search_path='' as $$
declare session_row public.housecall_test_sessions%rowtype;
begin
 perform public.require_active_actor(p_actor_id,array['admin']);
 perform public.require_active_actor(p_reviewer_id,array['manager','admin']);
 if length(btrim(coalesce(p_reason,''))) not between 1 and 2000 then raise exception 'invalid_request'; end if;
 select * into session_row from public.housecall_test_sessions where id=p_session_id for update;
 if session_row.id is null or session_row.revoked_at is not null or session_row.expires_at<=clock_timestamp()
  then raise exception 'test_export_scope'; end if;
 if session_row.authorized_by<>p_actor_id then raise exception 'forbidden'; end if;
 if p_reviewer_id=any(session_row.reviewer_ids) or exists(select 1 from public.housecall_test_reviewer_grants
  where session_id=p_session_id and reviewer_id=p_reviewer_id) then return; end if;
 if cardinality(session_row.reviewer_ids)+(select count(*) from public.housecall_test_reviewer_grants
  where session_id=p_session_id)>=10 then raise exception 'test_export_reviewer_limit'; end if;
 insert into public.housecall_test_reviewer_grants(session_id,reviewer_id,authorized_by,reason)
 values(p_session_id,p_reviewer_id,p_actor_id,btrim(p_reason));
end;$$;
revoke all on function public.authorize_housecall_test_reviewer(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.authorize_housecall_test_reviewer(uuid,uuid,uuid,text) to service_role;

create or replace function public.manager_review_with_test_export(
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
   or not(rec.owner_user_id=any(session_row.owner_ids))
   then raise exception 'test_export_scope'; end if;
  if not(p_actor_id=any(session_row.reviewer_ids)) and not exists(
   select 1 from public.housecall_test_reviewer_grants g
   where g.session_id=session_row.id and g.reviewer_id=p_actor_id
    and g.authorized_by=session_row.authorized_by)
   then raise exception 'test_export_reviewer'; end if;
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

