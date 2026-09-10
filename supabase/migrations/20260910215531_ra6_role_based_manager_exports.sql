-- A database manager's receipt approval is the production write authorization.
-- Existing test grants remain scoped; no historical intent is auto-authorized.
alter table public.housecall_write_approvals
 add column authorization_kind text not null default 'operator' check(authorization_kind in ('operator','manager_review')),
 add column job_bindings jsonb;
grant insert on public.housecall_write_approvals to service_role;

-- Keep privileged direct INSERTs subject to the same manager authorization.
-- Operator/test grants continue through the existing admin-only definer RPC.
create unique index housecall_manager_approval_intent_idx on public.housecall_write_approvals(intent_id)
 where authorization_kind='manager_review';
create function public.guard_housecall_manager_approval() returns trigger
language plpgsql security invoker set search_path='' as $$
declare intent public.housecall_intents%rowtype; bindings jsonb; jobs text[]; writes integer;
begin
 if new.authorization_kind<>'manager_review' then
  if current_user='service_role' then raise exception 'invalid_export_approval'; end if;
  return new;
 end if;
 perform public.require_active_actor(new.approved_by,array['manager','admin']);
 select * into intent from public.housecall_intents where id=new.intent_id;
 if intent.id is null or intent.payload_hash is distinct from new.payload_hash
  or not exists(select 1 from public.reviews r where r.id=intent.review_id and r.actor_id=new.approved_by and r.decision='approve')
  or not exists(select 1 from public.housecall_outbox o where o.intent_id=intent.id and o.status<>'cancelled')
  or new.test_session_id is not null or new.used_writes<>0 or new.revoked_at is not null
  then raise exception 'invalid_export_approval'; end if;
 select array_agg(value order by value) into jobs from jsonb_array_elements_text(intent.attachment_job_ids);
 select jsonb_object_agg(j.id,j.customer_id) into bindings from public.manager_job_catalog j where j.id=any(jobs);
 select count(*) into writes from public.housecall_export_steps where intent_id=intent.id;
 if new.job_ids is distinct from jobs or new.job_bindings is distinct from bindings
  or new.expires_at is distinct from 'infinity'::timestamptz or new.max_writes<>least(1000,writes*8)
  then raise exception 'invalid_export_approval'; end if;
 return new;
end;$$;
revoke all on function public.guard_housecall_manager_approval() from public,anon,authenticated,service_role;
create trigger housecall_manager_approval_guard before insert on public.housecall_write_approvals
 for each row execute function public.guard_housecall_manager_approval();


create function public.manager_review_with_export(
 p_receipt_id uuid,p_actor_id uuid,p_version integer,p_extraction_id uuid,
 p_decision text,p_snapshot jsonb,p_reason text default null,p_canonical_id uuid default null
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare result jsonb; intent public.housecall_intents%rowtype; approval public.housecall_write_approvals%rowtype;
 jobs text[]; bindings jsonb; writes integer;
begin
 perform public.require_active_actor(p_actor_id,array['manager','admin']);
 result:=public.manager_review_command(p_receipt_id,p_actor_id,p_version,p_extraction_id,p_decision,p_snapshot,p_reason,p_canonical_id);
 if p_decision<>'approve' then return result; end if;
 select * into intent from public.housecall_intents where id=(result->>'intentId')::uuid and receipt_id=p_receipt_id;
 select array_agg(value order by value) into jobs from jsonb_array_elements_text(intent.attachment_job_ids);
 if intent.payload_hash is null or jsonb_array_length(intent.approved_images)=0 or jobs is null or cardinality(jobs) not between 1 and 100
  or exists(select 1 from unnest(jobs) as requested(job_id) left join public.manager_job_catalog j on j.id=requested.job_id
   where j.id is null or j.source<>'housecall' or coalesce(j.customer_id,'')='' or j.unavailable
    or j.synced_at is null or j.synced_at<clock_timestamp()-interval '26 hours'
    or j.synced_at>clock_timestamp()+interval '1 minute')
  then raise exception 'invalid_request_job_unavailable'; end if;
 if exists(select 1 from public.housecall_export_steps where intent_id=intent.id and step='job_cost'
  and (payload#>>'{line,qty}')::numeric<>round((payload#>>'{line,qty}')::numeric,2))
  then raise exception 'unsupported_quantity_precision'; end if;
 select count(*) into writes from public.housecall_export_steps where intent_id=intent.id;
 if writes<2 or writes>600 or not exists(select 1 from public.housecall_export_steps where intent_id=intent.id and step='job_cost')
  then raise exception 'invalid_export_approval'; end if;
 select jsonb_object_agg(j.id,j.customer_id) into bindings from public.manager_job_catalog j where j.id=any(jobs);
 insert into public.housecall_write_approvals(intent_id,payload_hash,job_ids,approved_by,reason,expires_at,max_writes,authorization_kind,job_bindings)
 values(intent.id,intent.payload_hash,jobs,p_actor_id,'Manager approved the reviewed receipt and selected Housecall destinations',
  'infinity',least(1000,writes*8),'manager_review',bindings) returning * into approval;
 perform public.append_audit_event(p_receipt_id,'review_recorded',null,
  jsonb_build_object('approval_id',approval.id,'intent_id',intent.id,'payload_hash',intent.payload_hash,'job_bindings',bindings),
  jsonb_build_object('decision','manager_housecall_write_approval'),'user',p_actor_id);
 return result||jsonb_build_object('exportAuthorized',true);
end;$$;
revoke all on function public.manager_review_with_export(uuid,uuid,integer,uuid,text,jsonb,text,uuid) from public,anon,authenticated;
grant execute on function public.manager_review_with_export(uuid,uuid,integer,uuid,text,jsonb,text,uuid) to service_role;

-- Approval persists with the immutable receipt; each dispatch still gets a short
-- one-use permit, current-role verification, and the existing durable claim.
create or replace function public.consume_housecall_write_approval(p_step_id uuid,p_lease_token uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare result jsonb; session_row public.housecall_test_sessions%rowtype; authorized_at timestamptz;
begin
 result:=public.consume_housecall_write_approval_before_session(p_step_id,p_lease_token);
 if result->>'test_session_id' is not null then
  select * into session_row from public.housecall_test_sessions where id=(result->>'test_session_id')::uuid for share;
  if session_row.id is null or session_row.revoked_at is not null or session_row.expires_at<=clock_timestamp()
   then raise exception 'live_write_approval_required'; end if;
  perform public.require_active_actor(session_row.authorized_by,array['admin']);
 end if;
 if result->>'authorization_kind'='manager_review' then
  perform public.require_active_actor((result->>'approved_by')::uuid,array['manager','admin']);
  if jsonb_typeof(result->'job_bindings') is distinct from 'object'
   then raise exception 'live_write_approval_required'; end if;
  authorized_at:=clock_timestamp();
  result:=result||jsonb_build_object('dispatch_authorized_at',authorized_at,'dispatch_expires_at',authorized_at+interval '2 minutes');
 end if;
 return result;
end;$$;
