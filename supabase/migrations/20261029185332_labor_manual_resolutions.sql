-- Append-only manager attestations of manual Housecall corrections. This never
-- edits a provider record, changes a frozen approval, or releases reserved time.
create table public.labor_manual_corrections (
 id uuid primary key,
 approval_id uuid not null references public.labor_job_hour_approvals(id),
 snapshot_hash text not null check(snapshot_hash ~ '^[a-f0-9]{64}$'),
 recorded_by uuid not null references public.profiles(id),
 recorded_at timestamptz not null default clock_timestamp(),
 reason text not null check(length(btrim(reason)) between 10 and 2000),
 provider_reference text not null check(length(btrim(provider_reference)) between 1 and 500),
 evidence text not null check(length(btrim(evidence)) between 10 and 4000)
);
create index labor_manual_corrections_approval_idx on public.labor_manual_corrections(approval_id,recorded_at desc,id);
alter table public.labor_manual_corrections enable row level security;
revoke all on public.labor_manual_corrections from public,anon,authenticated,service_role;
grant select,insert on public.labor_manual_corrections to service_role;
create trigger labor_manual_corrections_immutable before update or delete on public.labor_manual_corrections
 for each row execute function public.reject_labor_event_mutation();

create function public.read_labor_manual_corrections(p_approval_id uuid,p_actor_id uuid) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
begin
 perform public.require_active_actor(p_actor_id,array['manager','admin']);
 if not exists(select 1 from public.labor_job_hour_approvals where id=p_approval_id) then
  raise exception 'labor_approval_not_found';
 end if;
 return (select coalesce(jsonb_agg(to_jsonb(c) order by c.recorded_at desc,c.id),'[]'::jsonb)
  from public.labor_manual_corrections c where c.approval_id=p_approval_id);
end; $$;

create function public.record_labor_manual_correction(
 p_approval_id uuid,p_request_id uuid,p_snapshot_hash text,p_actor_id uuid,
 p_reason text,p_provider_reference text,p_evidence text
) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare a public.labor_job_hour_approvals%rowtype; previous public.labor_manual_corrections%rowtype; saved public.labor_manual_corrections%rowtype;
begin
 -- Use the same lock order as approval/send operations; recheck role after waiting.
 perform 1 from public.labor_state where singleton for update;
 perform public.require_active_actor(p_actor_id,array['manager','admin']);
 select * into a from public.labor_job_hour_approvals where id=p_approval_id for update;
 if a.id is null then raise exception 'labor_approval_not_found'; end if;
 if p_request_id is null or p_snapshot_hash is null or p_snapshot_hash !~ '^[a-f0-9]{64}$'
  or p_reason is null or length(btrim(p_reason)) not between 10 and 2000
  or p_provider_reference is null or length(btrim(p_provider_reference)) not between 1 and 500
  or p_evidence is null or length(btrim(p_evidence)) not between 10 and 4000 then
  raise exception 'labor_correction_invalid_request';
 end if;
 if a.snapshot_hash<>p_snapshot_hash then raise exception 'labor_approval_stale'; end if;
 select * into previous from public.labor_manual_corrections where id=p_request_id;
 if previous.id is not null then
  if previous.approval_id<>p_approval_id or previous.snapshot_hash<>p_snapshot_hash or previous.recorded_by<>p_actor_id
   or previous.reason<>btrim(p_reason) or previous.provider_reference<>btrim(p_provider_reference) or previous.evidence<>btrim(p_evidence) then
   raise exception 'labor_correction_conflict';
  end if;
  return to_jsonb(previous);
 end if;
 if a.status not in ('sent','sending','reconciliation_required') or not exists(
  select 1 from public.labor_job_hour_attempts where approval_id=p_approval_id and dispatched_at is not null
 ) then raise exception 'labor_approval_invalid_status'; end if;
 if exists(select 1 from public.labor_job_hour_attempts where approval_id=p_approval_id
  and status in ('claimed','dispatched') and expires_at>clock_timestamp()) then
  raise exception 'labor_approval_dispatch_busy';
 end if;
 insert into public.labor_manual_corrections(id,approval_id,snapshot_hash,recorded_by,reason,provider_reference,evidence)
 values(p_request_id,p_approval_id,p_snapshot_hash,p_actor_id,btrim(p_reason),btrim(p_provider_reference),btrim(p_evidence)) returning * into saved;
 insert into public.labor_job_hour_events(approval_id,actor_id,event,details)
 values(p_approval_id,p_actor_id,'manual_resolution_recorded',jsonb_build_object('correctionId',saved.id,'snapshotHash',a.snapshot_hash,'providerReference',saved.provider_reference,'originalProviderReference',a.provider_reference,'attestationOnly',true));
 return to_jsonb(saved);
end; $$;

revoke all on function public.read_labor_manual_corrections(uuid,uuid) from public,anon,authenticated;
revoke all on function public.record_labor_manual_correction(uuid,uuid,text,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.read_labor_manual_corrections(uuid,uuid) to service_role;
grant execute on function public.record_labor_manual_correction(uuid,uuid,text,uuid,text,text,text) to service_role;
