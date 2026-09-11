-- RA-48: a mismatch may be handed to an administrator without claiming success
-- or leaving all later receipts on the destination permanently blocked.
create table public.housecall_manual_resolutions (
 id uuid primary key default gen_random_uuid(),
 receipt_id uuid not null references public.receipts(id) on delete cascade,
 intent_id uuid not null unique references public.housecall_intents(id) on delete cascade,
 actor_id uuid not null references public.profiles(id),
 reason text not null,
 evidence jsonb not null check(jsonb_typeof(evidence)='array'),
 created_at timestamptz not null default now()
);
create index housecall_manual_resolutions_receipt_idx on public.housecall_manual_resolutions(receipt_id);
create index housecall_manual_resolutions_actor_idx on public.housecall_manual_resolutions(actor_id);
alter table public.housecall_manual_resolutions enable row level security;
revoke all on public.housecall_manual_resolutions from public,anon,authenticated,service_role;
grant select on public.housecall_manual_resolutions to authenticated,service_role;
create policy housecall_manual_resolution_read on public.housecall_manual_resolutions for select to authenticated using (
 public.current_user_role() in ('manager','admin') and public.caller_is_active() and public.receipt_visible_to_caller(receipt_id)
 and exists(select 1 from public.receipts r where r.id=receipt_id and r.content_deleted_at is null and r.purge_claimed_at is null)
);

create function public.close_housecall_export_for_manual_handling(
 p_actor_id uuid,p_receipt_id uuid,p_intent_id uuid,p_payload_hash text,p_reason text,p_evidence jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare rec public.receipts%rowtype; intent public.housecall_intents%rowtype; s public.housecall_export_steps%rowtype;
 e jsonb; resolution_id uuid;
begin
 perform public.require_active_actor(p_actor_id,array['admin']);
 if length(btrim(coalesce(p_reason,''))) not between 1 and 2000 or p_evidence is null
  or jsonb_typeof(p_evidence)<>'array' or jsonb_array_length(p_evidence) not between 1 and 600
  or octet_length(p_evidence::text)>500000 then raise exception 'invalid_request'; end if;
 select * into rec from public.receipts where id=p_receipt_id for update;
 select * into intent from public.housecall_intents where id=p_intent_id and receipt_id=rec.id;
 if rec.id is null or rec.content_deleted_at is not null or rec.purge_claimed_at is not null
  or intent.payload_hash is distinct from p_payload_hash or p_payload_hash is null
  or not exists(select 1 from public.housecall_outbox where receipt_id=rec.id and intent_id=intent.id and status<>'cancelled')
  or exists(select 1 from public.manager_recovery_commands where receipt_id=rec.id and status in ('pending','processing'))
  then raise exception 'conflict'; end if;
 perform id from public.housecall_export_steps where intent_id=intent.id order by id for update;
 if exists(select 1 from public.housecall_export_steps where intent_id=intent.id and status='in_progress')
  or not exists(select 1 from public.housecall_export_steps where intent_id=intent.id and status<>'succeeded')
  or jsonb_array_length(p_evidence)<>(select count(*) from public.housecall_export_steps where intent_id=intent.id)
  or exists(select 1 from jsonb_array_elements(p_evidence) v group by v->>'step_id' having count(*)>1)
  then raise exception 'conflict'; end if;
 for s in select * from public.housecall_export_steps where intent_id=intent.id loop
  select value into e from jsonb_array_elements(p_evidence) where value->>'step_id'=s.id::text;
  if e is null or e->>'payload_hash' is distinct from s.payload_hash
   or (e->>'updated_at')::timestamptz is distinct from s.updated_at
   or e->>'job_id' is distinct from s.housecall_job_id
   or (e->>'observed_at')::timestamptz<clock_timestamp()-interval '5 minutes'
   or (e->>'observed_at')::timestamptz>clock_timestamp()
   or e->>'observed_at' is null then raise exception 'conflict'; end if;
  -- Absence cannot prove a dispatched write failed. A known provider record
  -- must be identified before releasing any dispatched/uncertain target.
  if s.dispatch_count>0 or s.status='succeeded' then
   if e->>'outcome' is distinct from 'present' or length(btrim(coalesce(e->>'external_id',''))) not between 1 and 500
    then raise exception 'reconciliation_required'; end if;
   if s.status='succeeded' and e->>'external_id' is distinct from s.external_id then raise exception 'conflict'; end if;
  elsif e->>'outcome' not in ('present','absent') or e->>'outcome' is null then raise exception 'invalid_request'; end if;
 end loop;
 insert into public.housecall_manual_resolutions(receipt_id,intent_id,actor_id,reason,evidence)
 values(rec.id,intent.id,p_actor_id,btrim(p_reason),p_evidence) returning id into resolution_id;
 update public.housecall_outbox set status='cancelled' where receipt_id=rec.id and intent_id=intent.id;
 update public.housecall_write_approvals set revoked_at=coalesce(revoked_at,clock_timestamp()) where intent_id=intent.id;
 insert into public.export_attempts(receipt_id,receipt_line_id,intent_id,housecall_job_id,step,status,payload_version,idempotency_key,error_code,export_step_id,evidence)
 select receipt_id,receipt_line_id,intent_id,housecall_job_id,step,'permanent_failure',intent.payload_version,
  idempotency_key||':manual-close','manual_handling',id,jsonb_build_object('resolution_id',resolution_id,'not_export_success',true)
 from public.housecall_export_steps where intent_id=intent.id and status<>'succeeded';
 update public.housecall_export_steps set status='permanent_failure',last_error='manual_handling',lease_token=null,lease_owner=null,lease_expires_at=null
 where intent_id=intent.id and status<>'succeeded';
 delete from public.housecall_export_locks where step_id in(select id from public.housecall_export_steps where intent_id=intent.id);
 update public.work_items set status='dead_letter',lease_owner=null,lease_expires_at=null,last_error='manual_handling',terminal_reason='manual_handling'
 where receipt_id=rec.id and kind='export';
 update public.receipts set status=case when exists(select 1 from public.housecall_export_steps where intent_id=intent.id and status='succeeded')
  then 'partial_success' else 'failed' end where id=rec.id;
 perform public.append_audit_event(rec.id,'work_dead_lettered',null,jsonb_build_object('resolution_id',resolution_id,'intent_id',intent.id),
  jsonb_build_object('decision','manual_handling','reason',btrim(p_reason),'not_export_success',true),'user',p_actor_id);
 return jsonb_build_object('resolutionId',resolution_id,'closed',true,'exported',false);
end;$$;
revoke all on function public.close_housecall_export_for_manual_handling(uuid,uuid,uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.close_housecall_export_for_manual_handling(uuid,uuid,uuid,text,text,jsonb) to service_role;

create function public.clear_housecall_resolution_content() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.content_deleted_at is not null and old.content_deleted_at is null then
  update public.housecall_manual_resolutions set reason='Content deleted',evidence='[]' where receipt_id=new.id;
 end if;
 return new;
end;$$;
revoke all on function public.clear_housecall_resolution_content() from public,anon,authenticated;
create trigger receipts_clear_housecall_resolutions before update of content_deleted_at on public.receipts
 for each row execute function public.clear_housecall_resolution_content();

-- RA-43: a complete scan of test customers must never mark other customers'
-- cached jobs missing, or masquerade as a full-business synchronization.
alter table public.housecall_sync_state add column customer_scope text[];
alter function public.finish_housecall_job_sync(uuid,timestamptz,jsonb,boolean,text[]) rename to finish_housecall_job_sync_before_scope;
create function public.finish_housecall_job_sync(p_lease_token uuid,p_started_at timestamptz,p_jobs jsonb,p_full boolean,p_observed_job_ids text[] default null,p_customer_ids text[] default null)
returns integer language plpgsql security invoker set search_path='' as $$
declare n integer;
begin
 if p_customer_ids is not null then
  if cardinality(p_customer_ids) not between 1 and 20 or exists(select 1 from unnest(p_customer_ids)v where v is null or v !~ '^[A-Za-z0-9_-]{1,160}$')
   or exists(select 1 from jsonb_array_elements(p_jobs)j where coalesce(j->>'customer_id','')<>all(p_customer_ids))
   or exists(select 1 from public.manager_job_catalog where id=any(p_observed_job_ids) and coalesce(customer_id,'')<>all(p_customer_ids))
   then raise exception 'invalid_request'; end if;
  n:=public.finish_housecall_job_sync_before_scope(p_lease_token,p_started_at,p_jobs,false,p_observed_job_ids);
  if p_full then
   update public.manager_job_catalog set unavailable=true,active=false where source='housecall' and customer_id=any(p_customer_ids)
    and not(id=any(coalesce(p_observed_job_ids,array(select j->>'id' from jsonb_array_elements(p_jobs)j))));
   update public.housecall_sync_state set last_full_sync_at=p_started_at where id;
  end if;
 else
  n:=public.finish_housecall_job_sync_before_scope(p_lease_token,p_started_at,p_jobs,p_full,p_observed_job_ids);
 end if;
 update public.housecall_sync_state set customer_scope=p_customer_ids where id;
 return n;
end;$$;
revoke all on function public.finish_housecall_job_sync(uuid,timestamptz,jsonb,boolean,text[],text[]) from public,anon,authenticated;
grant execute on function public.finish_housecall_job_sync(uuid,timestamptz,jsonb,boolean,text[],text[]) to service_role;
