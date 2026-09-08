-- Immediate processing must not depend on an unrelated queue backlog or the
-- daily recovery cron. Claim at most one due stage of exactly one receipt.
create function public.claim_receipt_work(
 p_receipt_id uuid,p_worker_id text,p_kind text,p_lease_seconds integer default 300
) returns setof public.work_items language plpgsql security invoker set search_path='' as $$
declare item public.work_items%rowtype; previous public.work_items%rowtype;
begin
 if p_receipt_id is null or length(btrim(coalesce(p_worker_id,''))) not between 1 and 200
  or p_kind is null or p_kind not in ('readability','extract') or p_lease_seconds is null or p_lease_seconds not between 1 and 300 then raise exception 'invalid_request'; end if;
 select w.* into previous from public.work_items w join public.receipts r on r.id=w.receipt_id
 where w.receipt_id=p_receipt_id and w.kind=p_kind and w.status in ('queued','leased')
  and w.next_attempt_at<=now() and (w.status='queued' or w.lease_expires_at is null or w.lease_expires_at<=now())
  and r.submitted_at is not null and r.content_deleted_at is null and r.purge_claimed_at is null
  and r.status in ('submitted','processing','needs_review','failed')
  and (p_kind='readability' or exists(select 1 from public.readability_checks where receipt_id=r.id and readable))
 for update of w skip locked limit 1;
 if not found then return; end if;
 update public.work_items set status='leased',lease_owner=p_worker_id,lease_expires_at=now()+make_interval(secs=>p_lease_seconds),attempt_count=attempt_count+1
 where id=previous.id returning * into item;
 perform public.append_audit_event(item.receipt_id,'work_started',
  jsonb_build_object('kind',previous.kind,'status',previous.status,'attempt_count',previous.attempt_count,'lease_owner',previous.lease_owner),
  jsonb_build_object('kind',item.kind,'status',item.status,'attempt_count',item.attempt_count,'lease_owner',item.lease_owner),
  jsonb_build_object('worker_id',p_worker_id),'worker',null);
 return next item;
end;$$;
revoke all on function public.claim_receipt_work(uuid,text,text,integer) from public,anon,authenticated;
grant execute on function public.claim_receipt_work(uuid,text,text,integer) to service_role;

-- Budget exhaustion before inference is not a provider failure. Restore the
-- caller's exact stage to its original due time without spending an attempt.
create function public.release_receipt_work(p_work_id uuid,p_worker_id text)
 returns public.work_items language plpgsql security invoker set search_path='' as $$
declare item public.work_items%rowtype;
begin
 select * into item from public.work_items where id=p_work_id for update;
 if not found or item.kind not in ('readability','extract') or item.status<>'leased' or item.lease_owner is distinct from p_worker_id then raise exception 'conflict';end if;
 update public.work_items set status='queued',lease_owner=null,lease_expires_at=null,attempt_count=greatest(attempt_count-1,0) where id=item.id returning * into item;
 perform public.append_audit_event(item.receipt_id,'work_retried',jsonb_build_object('kind',item.kind),jsonb_build_object('status','queued'),jsonb_build_object('worker_id',p_worker_id,'reason','deferred'),'worker',null);
 return item;
end;$$;
revoke all on function public.release_receipt_work(uuid,text) from public,anon,authenticated;
grant execute on function public.release_receipt_work(uuid,text) to service_role;
