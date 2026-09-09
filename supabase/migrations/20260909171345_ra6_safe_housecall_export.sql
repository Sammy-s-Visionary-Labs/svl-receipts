-- RA-6: immutable export instructions and a fail-closed write coordinator.
-- No provider calls, seeded approvals, automatic live access, or hosted changes.
-- SECURITY DEFINER RPCs below are service-only and have fixed search paths;
-- grant creation additionally verifies an active administrator actor.

alter table public.housecall_intents
  add column approved_images jsonb not null default '[]' check(jsonb_typeof(approved_images)='array'),
  add column approved_reference text not null default '',
  add column payload_hash text check(payload_hash is null or payload_hash ~ '^[a-f0-9]{64}$'),
  add column supersedes_intent_id uuid references public.housecall_intents(id);

create function public.housecall_payload_hash(p_payload jsonb) returns text
language sql immutable strict security invoker set search_path='' as $$
 select encode(sha256(convert_to(p_payload::text,'UTF8')),'hex')
$$;
revoke all on function public.housecall_payload_hash(jsonb) from public,anon,authenticated;
grant execute on function public.housecall_payload_hash(jsonb) to service_role;

create table public.housecall_export_steps (
 id uuid primary key default gen_random_uuid(),
 intent_id uuid not null references public.housecall_intents(id) on delete cascade,
 receipt_id uuid not null references public.receipts(id) on delete cascade,
 housecall_job_id text not null check(length(btrim(housecall_job_id)) between 1 and 200),
 step text not null check(step in ('attachment','job_cost')),
 receipt_page_id uuid references public.receipt_pages(id) on delete set null,
 receipt_line_id uuid references public.receipt_lines(id) on delete set null,
 payload jsonb check(payload is null or jsonb_typeof(payload)='object'),
 payload_hash text not null check(payload_hash ~ '^[a-f0-9]{64}$'),
 idempotency_key text not null unique,
 status text not null default 'ready' check(status in ('ready','in_progress','reconcile_required','succeeded','retryable_failure','permanent_failure')),
 lease_token uuid, lease_owner text, lease_expires_at timestamptz,
 reconcile_only boolean not null default false,
 dispatch_started_at timestamptz,
 attempt_count integer not null default 0 check(attempt_count>=0),
 dispatch_count integer not null default 0 check(dispatch_count between 0 and 8),
 external_id text, last_error text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index housecall_export_steps_page_key on public.housecall_export_steps(intent_id,housecall_job_id,receipt_page_id) where step='attachment';
create unique index housecall_export_steps_line_key on public.housecall_export_steps(intent_id,housecall_job_id,receipt_line_id) where step='job_cost';
create index housecall_export_steps_claim_idx on public.housecall_export_steps(intent_id,status,created_at,id);
create index housecall_export_steps_destination_idx on public.housecall_export_steps(housecall_job_id,status);
create index housecall_export_steps_receipt_idx on public.housecall_export_steps(receipt_id);
create index housecall_export_steps_page_idx on public.housecall_export_steps(receipt_page_id) where receipt_page_id is not null;
create index housecall_export_steps_line_idx on public.housecall_export_steps(receipt_line_id) where receipt_line_id is not null;
create index housecall_intents_supersedes_idx on public.housecall_intents(supersedes_intent_id) where supersedes_intent_id is not null;

-- Persistent locks survive separate HTTP/RPC transactions. An unresolved step
-- blocks other writes to its receipt AND destination, even after lease expiry.
create table public.housecall_export_locks (
 lock_key text primary key, step_id uuid not null references public.housecall_export_steps(id) on delete cascade,
 lease_token uuid not null, lease_expires_at timestamptz not null
);
create index housecall_export_locks_step_idx on public.housecall_export_locks(step_id);
create table public.housecall_write_approvals (
 id uuid primary key default gen_random_uuid(),
 intent_id uuid not null references public.housecall_intents(id) on delete cascade,
 payload_hash text not null check(payload_hash ~ '^[a-f0-9]{64}$'),
 job_ids text[] not null check(cardinality(job_ids)>0),
 approved_by uuid not null references auth.users(id), reason text not null,
 expires_at timestamptz not null,
 max_writes integer not null check(max_writes between 1 and 1000),
 used_writes integer not null default 0 check(used_writes between 0 and max_writes),
 revoked_at timestamptz, created_at timestamptz not null default now()
);
create index housecall_write_approvals_intent_idx on public.housecall_write_approvals(intent_id,expires_at);
create index housecall_write_approvals_actor_idx on public.housecall_write_approvals(approved_by);

alter table public.housecall_export_steps enable row level security;
alter table public.housecall_export_locks enable row level security;
alter table public.housecall_write_approvals enable row level security;
revoke all on public.housecall_export_steps,public.housecall_export_locks,public.housecall_write_approvals from public,anon,authenticated,service_role;
grant select on public.housecall_export_steps,public.housecall_write_approvals to service_role;
grant select on public.housecall_export_steps to authenticated;
create policy housecall_export_steps_manager_read on public.housecall_export_steps for select to authenticated using(
 public.current_user_role() in ('manager','admin') and public.caller_is_active()
 and public.receipt_visible_to_caller(receipt_id)
 and exists(select 1 from public.receipts r where r.id=receipt_id and r.content_deleted_at is null and r.purge_claimed_at is null)
);

alter table public.export_attempts add column export_step_id uuid references public.housecall_export_steps(id) on delete cascade,
 add column evidence jsonb not null default '{}' check(jsonb_typeof(evidence)='object');
alter table public.housecall_links add column export_step_id uuid references public.housecall_export_steps(id) on delete cascade;
-- Preserve legacy invariants while giving each frozen page/line/version its own
-- identity. A new version never reuses an old successful link as new success.
drop index public.housecall_links_attachment_uidx;
drop index public.housecall_links_job_cost_uidx;
drop index public.export_attempts_succeeded_attachment_uidx;
drop index public.export_attempts_succeeded_job_cost_uidx;
create unique index housecall_links_attachment_uidx on public.housecall_links(receipt_id,housecall_job_id) where step='attachment' and export_step_id is null;
create unique index housecall_links_job_cost_uidx on public.housecall_links(receipt_id,receipt_line_id,housecall_job_id) where step='job_cost' and export_step_id is null;
create unique index export_attempts_succeeded_attachment_uidx on public.export_attempts(receipt_id,housecall_job_id) where status='succeeded' and step='attachment' and export_step_id is null;
create unique index export_attempts_succeeded_job_cost_uidx on public.export_attempts(receipt_id,receipt_line_id,housecall_job_id) where status='succeeded' and step='job_cost' and export_step_id is null;
create unique index housecall_links_export_step_key on public.housecall_links(export_step_id) where export_step_id is not null;
create unique index housecall_links_external_identity_key on public.housecall_links(housecall_job_id,step,external_id) where export_step_id is not null;
create unique index export_attempts_succeeded_step_key on public.export_attempts(export_step_id) where export_step_id is not null and status='succeeded';
create index export_attempts_step_idx on public.export_attempts(export_step_id,created_at);

create function public.freeze_housecall_intent() returns trigger language plpgsql security definer set search_path='' as $$
declare rec public.receipts%rowtype; previous public.housecall_intents%rowtype; approved_snapshot jsonb; reference_number text;
begin
 select * into rec from public.receipts where id=new.receipt_id for update;
 if rec.content_deleted_at is not null or rec.purge_claimed_at is not null then raise exception 'conflict'; end if;
 -- Historical RA-2 records lack versioned manager snapshots. They remain
 -- readable but cannot be claimed by the RA-6 live worker.
 if not exists(select 1 from public.reviews where id=new.review_id and receipt_id=new.receipt_id and version is not null and decision='approve') then
  new.payload_hash:=null; new.approved_images:='[]'; new.approved_reference:=''; return new;
 end if;
 select snapshot into approved_snapshot from public.reviews where id=new.review_id;
 reference_number:=coalesce(nullif(btrim(approved_snapshot->>'invoiceNumber'),''),nullif(btrim(approved_snapshot->>'ticketNumber'),''));
 new.approved_reference:=concat_ws(' ',nullif(btrim(approved_snapshot->>'vendor'),''),
  case when reference_number is not null then '#'||reference_number end,nullif(btrim(approved_snapshot->>'purchaseDate'),''));
 select * into previous from public.housecall_intents where receipt_id=new.receipt_id order by created_at desc,id desc limit 1;
 if found then
  -- Corrections remain explicit manager commands awaiting reconciliation.
  -- Do not turn them into an additive replay or silently supersede old costs.
  raise exception 'correction_requires_reconciliation';
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('page_id',p.id,'page_index',p.page_index,'storage_key',p.storage_key,
   'content_type',p.content_type,'checksum',p.checksum,'byte_size',p.byte_size) order by p.page_index),'[]') into new.approved_images
 from public.receipt_pages p where p.receipt_id=new.receipt_id and p.confirmed_at is not null;
 -- Missing/partially confirmed image sets can be inspected in dry-run but can
 -- never obtain a write approval or be claimed for export.
 if exists(select 1 from public.receipt_pages where receipt_id=new.receipt_id and confirmed_at is null) then new.approved_images:='[]'; end if;
 new.payload_hash:=public.housecall_payload_hash(jsonb_build_object('id',new.id,'receipt_id',new.receipt_id,
  'review_id',new.review_id,'payload_version',new.payload_version,'attachment_job_ids',new.attachment_job_ids,
  'job_cost_lines',new.job_cost_lines,'approved_images',new.approved_images,'approved_reference',new.approved_reference));
 return new;
end;$$;
revoke all on function public.freeze_housecall_intent() from public,anon,authenticated,service_role;
create trigger housecall_intents_freeze before insert on public.housecall_intents for each row execute function public.freeze_housecall_intent();

create function public.plan_housecall_intent() returns trigger language plpgsql security definer set search_path='' as $$
declare job_id text; img jsonb; line jsonb; body jsonb; digest text;
begin
 if new.payload_hash is null then return new; end if;
 for job_id in select distinct jsonb_array_elements_text(new.attachment_job_ids) loop
  for img in select value from jsonb_array_elements(new.approved_images) loop
   body:=jsonb_build_object('intent_id',new.id,'receipt_id',new.receipt_id,'payload_version',new.payload_version,
    'housecall_job_id',job_id,'step','attachment','image',img,'approved_reference',new.approved_reference);
   digest:=public.housecall_payload_hash(body);
   insert into public.housecall_export_steps(intent_id,receipt_id,housecall_job_id,step,receipt_page_id,payload,payload_hash,idempotency_key)
    values(new.id,new.receipt_id,job_id,'attachment',(img->>'page_id')::uuid,body,digest,'ra6:'||digest);
  end loop;
 end loop;
 for line in select value from jsonb_array_elements(new.job_cost_lines) loop
  if not(new.attachment_job_ids ? (line->>'job_id')) or (line->>'qty')::numeric<=0 or
   (line->>'unit_cost_cents')::numeric<0 or (line->>'extended_cost_cents')::numeric<>round((line->>'qty')::numeric*(line->>'unit_cost_cents')::numeric)
   or not exists(select 1 from public.receipt_lines where id=(line->>'receipt_line_id')::uuid and receipt_id=new.receipt_id)
   then raise exception 'invalid_export_plan'; end if;
  body:=jsonb_build_object('intent_id',new.id,'receipt_id',new.receipt_id,'payload_version',new.payload_version,
   'housecall_job_id',line->>'job_id','step','job_cost','line',line,'approved_reference',new.approved_reference);
  digest:=public.housecall_payload_hash(body);
  insert into public.housecall_export_steps(intent_id,receipt_id,housecall_job_id,step,receipt_line_id,payload,payload_hash,idempotency_key)
   values(new.id,new.receipt_id,line->>'job_id','job_cost',(line->>'receipt_line_id')::uuid,body,digest,'ra6:'||digest);
 end loop;
 return new;
end;$$;
revoke all on function public.plan_housecall_intent() from public,anon,authenticated,service_role;
create trigger housecall_intents_plan after insert on public.housecall_intents for each row execute function public.plan_housecall_intent();

create function public.guard_housecall_export_step() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if current_setting('svl.allow_purge',true)='true' then return new; end if;
 -- The existing AFTER-purge trigger removes page rows after our content
 -- redaction trigger has restored the caller's purge setting.
 if new.receipt_page_id is null and old.receipt_page_id is not null and old.payload is null
  and (to_jsonb(new)-'receipt_page_id')=(to_jsonb(old)-'receipt_page_id')
  and exists(select 1 from public.receipts where id=old.receipt_id and content_deleted_at is not null) then return new; end if;
 if row(new.id,new.intent_id,new.receipt_id,new.housecall_job_id,new.step,new.receipt_page_id,new.receipt_line_id,new.payload,new.payload_hash,new.idempotency_key)
  is distinct from row(old.id,old.intent_id,old.receipt_id,old.housecall_job_id,old.step,old.receipt_page_id,old.receipt_line_id,old.payload,old.payload_hash,old.idempotency_key)
  then raise exception 'export_plan_is_immutable'; end if;
 if old.status='succeeded' and new is distinct from old then raise exception 'export_success_is_immutable'; end if;
 new.updated_at:=now(); return new;
end;$$;
revoke all on function public.guard_housecall_export_step() from public,anon,authenticated,service_role;
create trigger housecall_export_steps_guard before update on public.housecall_export_steps for each row execute function public.guard_housecall_export_step();

create function public.grant_housecall_write_approval(
 p_actor_id uuid,p_intent_id uuid,p_payload_hash text,p_job_ids text[],p_expires_at timestamptz,p_max_writes integer,p_reason text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare intent public.housecall_intents%rowtype; grant_row public.housecall_write_approvals%rowtype; rec public.receipts%rowtype;
begin
 perform public.require_active_actor(p_actor_id,array['admin']);
 select * into intent from public.housecall_intents where id=p_intent_id;
 select * into rec from public.receipts where id=intent.receipt_id for update;
 if intent.id is null or intent.payload_hash is null or p_payload_hash is distinct from intent.payload_hash
  or jsonb_array_length(intent.approved_images)=0 or rec.content_deleted_at is not null or rec.purge_claimed_at is not null
  or not exists(select 1 from public.housecall_outbox where receipt_id=intent.receipt_id and intent_id=intent.id and status<>'cancelled')
  then raise exception 'invalid_export_approval'; end if;
 if p_job_ids is null or cardinality(p_job_ids)=0 or cardinality(p_job_ids)>100
  or exists(select 1 from unnest(p_job_ids) j where j is null or not(intent.attachment_job_ids ? j))
  or p_expires_at is null or p_expires_at<=clock_timestamp() or p_expires_at>clock_timestamp()+interval '24 hours'
  or p_max_writes is null or p_max_writes not between 1 and 1000 or length(btrim(coalesce(p_reason,''))) not between 1 and 2000
  then raise exception 'invalid_export_approval'; end if;
 insert into public.housecall_write_approvals(intent_id,payload_hash,job_ids,approved_by,reason,expires_at,max_writes)
 values(intent.id,intent.payload_hash,p_job_ids,p_actor_id,btrim(p_reason),p_expires_at,p_max_writes) returning * into grant_row;
 perform public.append_audit_event(intent.receipt_id,'review_recorded',null,to_jsonb(grant_row),jsonb_build_object('decision','explicit_housecall_write_approval'),'user',p_actor_id);
 return to_jsonb(grant_row);
end;$$;
revoke all on function public.grant_housecall_write_approval(uuid,uuid,text,text[],timestamptz,integer,text) from public,anon,authenticated;
grant execute on function public.grant_housecall_write_approval(uuid,uuid,text,text[],timestamptz,integer,text) to service_role;

create function public.revoke_housecall_write_approval(p_actor_id uuid,p_approval_id uuid,p_reason text) returns void
language plpgsql security definer set search_path='' as $$
declare g public.housecall_write_approvals%rowtype;
begin
 perform public.require_active_actor(p_actor_id,array['admin']);
 if length(btrim(coalesce(p_reason,''))) not between 1 and 2000 then raise exception 'invalid_request'; end if;
 select * into g from public.housecall_write_approvals where id=p_approval_id for update;
 if not found then raise exception 'invalid_request'; end if;
 update public.housecall_write_approvals set revoked_at=coalesce(revoked_at,now()) where id=g.id;
 perform public.append_audit_event((select receipt_id from public.housecall_intents where id=g.intent_id),'review_recorded',to_jsonb(g),
  jsonb_build_object('approval_id',g.id,'revoked',true),jsonb_build_object('decision','revoke_housecall_write_approval','reason',btrim(p_reason)),'user',p_actor_id);
end;$$;
revoke all on function public.revoke_housecall_write_approval(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.revoke_housecall_write_approval(uuid,uuid,text) to service_role;

create function public.claim_housecall_export_step(p_intent_id uuid,p_worker_id text,p_lease_seconds integer default 120)
returns jsonb language plpgsql security definer set search_path='' as $$
declare intent public.housecall_intents%rowtype; rec public.receipts%rowtype; s public.housecall_export_steps%rowtype;
 token uuid:=gen_random_uuid(); reconcile boolean; key text; lock_row public.housecall_export_locks%rowtype;
begin
 if length(btrim(coalesce(p_worker_id,''))) not between 1 and 200 or p_lease_seconds is null or p_lease_seconds not between 30 and 600 then raise exception 'invalid_request'; end if;
 select * into intent from public.housecall_intents where id=p_intent_id;
 if intent.id is null or intent.payload_hash is null or jsonb_array_length(intent.approved_images)=0 then return null; end if;
 select * into rec from public.receipts where id=intent.receipt_id for update;
 if rec.content_deleted_at is not null or rec.purge_claimed_at is not null or rec.status not in ('approved','exporting','partial_success','failed')
  or not exists(select 1 from public.housecall_outbox where receipt_id=rec.id and intent_id=intent.id and status<>'cancelled')
  or exists(select 1 from public.manager_recovery_commands where receipt_id=rec.id and kind='correction' and status in ('pending','processing'))
  then return null; end if;
 if exists(select 1 from public.housecall_export_steps where receipt_id=rec.id and status='in_progress' and lease_expires_at>clock_timestamp()) then return null; end if;
 select * into s from public.housecall_export_steps where intent_id=intent.id
  and (status in ('ready','retryable_failure','reconcile_required') or (status='in_progress' and lease_expires_at<=clock_timestamp()))
  order by (status in ('reconcile_required','in_progress')) desc,case step when 'attachment' then 0 else 1 end,housecall_job_id,created_at,id for update skip locked limit 1;
 if not found then return null; end if;
 if s.dispatch_count>=8 and s.status in ('ready','retryable_failure') then
  update public.housecall_export_steps set status='permanent_failure',last_error='attempt_limit_reached' where id=s.id;
  insert into public.export_attempts(receipt_id,receipt_line_id,intent_id,housecall_job_id,step,status,payload_version,idempotency_key,error_code,export_step_id,created_at)
   values(s.receipt_id,s.receipt_line_id,s.intent_id,s.housecall_job_id,s.step,'permanent_failure',intent.payload_version,s.idempotency_key||':dispatch-limit','attempt_limit_reached',s.id,clock_timestamp());
  return null;
 end if;
 reconcile:=s.status in ('reconcile_required','in_progress');
 for key in select v from unnest(array['receipt:'||rec.id::text,'job:'||s.housecall_job_id]) v order by v loop
  if not pg_try_advisory_xact_lock(hashtextextended(key,0)) then return null; end if;
  select * into lock_row from public.housecall_export_locks where lock_key=key for update;
  if found and lock_row.step_id<>s.id and lock_row.lease_expires_at>clock_timestamp() then return null; end if;
 end loop;
 if exists(select 1 from public.housecall_export_steps other where other.housecall_job_id=s.housecall_job_id and other.id<>s.id
  and other.status in ('in_progress','reconcile_required')) then return null; end if;
 -- No lock mutations until every fence is checked.
 for key in select v from unnest(array['receipt:'||rec.id::text,'job:'||s.housecall_job_id]) v order by v loop
  insert into public.housecall_export_locks(lock_key,step_id,lease_token,lease_expires_at)
   values(key,s.id,token,clock_timestamp()+make_interval(secs=>p_lease_seconds))
   on conflict(lock_key) do update set step_id=excluded.step_id,lease_token=excluded.lease_token,lease_expires_at=excluded.lease_expires_at;
 end loop;
 update public.housecall_export_steps set status='in_progress',lease_token=token,lease_owner=p_worker_id,
  lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),reconcile_only=reconcile,
  dispatch_started_at=null,attempt_count=attempt_count+1 where id=s.id returning * into s;
 insert into public.export_attempts(receipt_id,receipt_line_id,intent_id,housecall_job_id,step,status,payload_version,idempotency_key,export_step_id,created_at)
  values(s.receipt_id,s.receipt_line_id,s.intent_id,s.housecall_job_id,s.step,'pending',intent.payload_version,s.idempotency_key||':'||s.attempt_count||':claimed',s.id,clock_timestamp());
 return jsonb_build_object('step',to_jsonb(s),'reconcileOnly',reconcile);
end;$$;
revoke all on function public.claim_housecall_export_step(uuid,text,integer) from public,anon,authenticated;
grant execute on function public.claim_housecall_export_step(uuid,text,integer) to service_role;

create function public.consume_housecall_write_approval(p_step_id uuid,p_lease_token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.housecall_export_steps%rowtype; intent public.housecall_intents%rowtype; g public.housecall_write_approvals%rowtype; rec public.receipts%rowtype;
begin
 select * into s from public.housecall_export_steps where id=p_step_id;
 select * into rec from public.receipts where id=s.receipt_id for update;
 select * into s from public.housecall_export_steps where id=p_step_id for update;
 if s.id is null or s.status<>'in_progress' or s.lease_token is distinct from p_lease_token or s.lease_expires_at<=clock_timestamp()
  or s.reconcile_only or s.dispatch_started_at is not null or s.payload is null or rec.content_deleted_at is not null or rec.purge_claimed_at is not null
  or exists(select 1 from public.manager_recovery_commands where receipt_id=s.receipt_id and kind='correction' and status in ('pending','processing'))
  or (select count(*) from public.housecall_export_locks where step_id=s.id and lease_token=p_lease_token and lease_expires_at>clock_timestamp())<>2
  then raise exception 'conflict'; end if;
 if s.dispatch_count>=8 then raise exception 'attempt_limit_reached'; end if;
 select * into intent from public.housecall_intents where id=s.intent_id;
 if not exists(select 1 from public.housecall_outbox where receipt_id=s.receipt_id and intent_id=s.intent_id and status<>'cancelled') then raise exception 'conflict'; end if;
 select * into g from public.housecall_write_approvals where intent_id=s.intent_id and payload_hash=intent.payload_hash
  and s.housecall_job_id=any(job_ids) and revoked_at is null and expires_at>clock_timestamp() and used_writes<max_writes
  order by expires_at,id for update skip locked limit 1;
 if not found then raise exception 'live_write_approval_required'; end if;
 update public.housecall_write_approvals set used_writes=used_writes+1 where id=g.id returning * into g;
 update public.housecall_export_steps set dispatch_started_at=clock_timestamp(),dispatch_count=dispatch_count+1 where id=s.id;
 update public.receipts set status='exporting' where id=s.receipt_id and status<>'exporting';
 insert into public.export_attempts(receipt_id,receipt_line_id,intent_id,housecall_job_id,step,status,payload_version,idempotency_key,export_step_id,evidence,created_at)
 values(s.receipt_id,s.receipt_line_id,s.intent_id,s.housecall_job_id,s.step,'in_progress',intent.payload_version,s.idempotency_key||':'||s.attempt_count||':dispatch',s.id,jsonb_build_object('approval_id',g.id,'payload_hash',s.payload_hash),clock_timestamp());
 return to_jsonb(g)||jsonb_build_object('step_payload_hash',s.payload_hash,'step_id',s.id,'idempotency_key',s.idempotency_key);
end;$$;
revoke all on function public.consume_housecall_write_approval(uuid,uuid) from public,anon,authenticated;
grant execute on function public.consume_housecall_write_approval(uuid,uuid) to service_role;

create function public.finish_housecall_export_step(
 p_step_id uuid,p_lease_token uuid,p_outcome text,p_external_id text default null,p_error_code text default null,p_evidence jsonb default '{}'
) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.housecall_export_steps%rowtype; intent public.housecall_intents%rowtype; next_status text; event_status text; complete boolean;
begin
 select * into s from public.housecall_export_steps where id=p_step_id;
 perform id from public.receipts where id=s.receipt_id for update;
 select * into s from public.housecall_export_steps where id=p_step_id for update;
 if s.id is null or s.lease_token is distinct from p_lease_token then raise exception 'conflict'; end if;
 if s.status='succeeded' and p_outcome='succeeded' and s.external_id=p_external_id then return to_jsonb(s); end if;
 if s.status<>'in_progress' or s.lease_expires_at<=clock_timestamp() or
  (select count(*) from public.housecall_export_locks where step_id=s.id and lease_token=p_lease_token and lease_expires_at>clock_timestamp())<>2 then raise exception 'conflict'; end if;
 if p_outcome is null or p_outcome not in ('succeeded','not_sent','retryable_failure','permanent_failure','uncertain','not_found')
  or jsonb_typeof(p_evidence) is distinct from 'object' or octet_length(p_evidence::text)>8000
  or length(coalesce(p_error_code,''))>200 then raise exception 'invalid_request'; end if;
 if p_outcome='succeeded' then
  if length(btrim(coalesce(p_external_id,''))) not between 1 and 500 or p_evidence->>'verified' is distinct from 'true'
   or p_evidence->>'housecall_job_id' is distinct from s.housecall_job_id or p_evidence->>'payload_hash' is distinct from s.payload_hash
   then raise exception 'verification_required'; end if;
  next_status:='succeeded'; event_status:='succeeded';
 elsif p_outcome='not_sent' then
  if s.dispatch_started_at is not null or s.reconcile_only then raise exception 'reconciliation_required'; end if;
  next_status:='ready'; event_status:='skipped';
 elsif p_outcome='retryable_failure' then
  if s.reconcile_only or (s.dispatch_started_at is not null and
   (p_evidence->>'definitive_rejection' is distinct from 'true' or coalesce(p_evidence->>'http_status','') not in ('400','401','403','404','422','429')))
   then raise exception 'reconciliation_required'; end if;
  next_status:='retryable_failure'; event_status:='retryable_failure';
 elsif p_outcome='permanent_failure' and not s.reconcile_only then
  if s.dispatch_started_at is not null and (p_evidence->>'definitive_rejection' is distinct from 'true' or coalesce(p_evidence->>'http_status','') not in ('400','401','403','404','422','429')) then raise exception 'reconciliation_required'; end if;
  next_status:='permanent_failure'; event_status:='permanent_failure';
 else next_status:='reconcile_required'; event_status:='permanent_failure'; end if;
 if next_status='retryable_failure' and s.dispatch_count>=8 then next_status:='permanent_failure';event_status:='permanent_failure';p_error_code:='attempt_limit_reached';end if;
 select * into intent from public.housecall_intents where id=s.intent_id;
 update public.housecall_export_steps set status=next_status,external_id=case when next_status='succeeded' then p_external_id else external_id end,
  last_error=case when next_status='reconcile_required' then 'reconciliation_required' else p_error_code end,
  lease_owner=null,lease_expires_at=null where id=s.id returning * into s;
 if next_status='succeeded' then
  insert into public.housecall_links(receipt_id,receipt_line_id,intent_id,housecall_job_id,step,payload_version,external_id,export_step_id)
   values(s.receipt_id,s.receipt_line_id,s.intent_id,s.housecall_job_id,s.step,intent.payload_version,p_external_id,s.id);
 end if;
 insert into public.export_attempts(receipt_id,receipt_line_id,intent_id,housecall_job_id,step,status,payload_version,idempotency_key,external_id,error_code,export_step_id,evidence,created_at)
 values(s.receipt_id,s.receipt_line_id,s.intent_id,s.housecall_job_id,s.step,event_status,intent.payload_version,
  s.idempotency_key||':'||s.attempt_count||':finished',case when next_status='succeeded' then p_external_id else null end,s.last_error,s.id,p_evidence,clock_timestamp());
 delete from public.housecall_export_locks where step_id=s.id and lease_token=p_lease_token;
 complete:=public.both_housecall_steps_succeeded(s.receipt_id);
 if complete then
  update public.receipts set status='exported' where id=s.receipt_id;
  update public.housecall_outbox set status='dispatched' where receipt_id=s.receipt_id and intent_id=s.intent_id;
  update public.work_items set status='succeeded',lease_owner=null,lease_expires_at=null,last_error=null,terminal_reason=null where receipt_id=s.receipt_id and kind='export';
 elsif next_status<>'ready' then
  update public.receipts set status=case when exists(select 1 from public.housecall_export_steps where intent_id=s.intent_id and status='succeeded') then 'partial_success' else 'failed' end where id=s.receipt_id;
 end if;
 return to_jsonb(s);
end;$$;
revoke all on function public.finish_housecall_export_step(uuid,uuid,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.finish_housecall_export_step(uuid,uuid,text,text,text,jsonb) to service_role;

-- Keep historical checks intact; current RA-6 plans require every frozen image
-- on every target and every cost line to have verified durable linkage.
alter function public.both_housecall_steps_succeeded(uuid) rename to both_housecall_steps_succeeded_legacy;
create function public.both_housecall_steps_succeeded(p_receipt_id uuid) returns boolean
language plpgsql stable security definer set search_path='' as $$
declare intent public.housecall_intents%rowtype; expected integer;
begin
 select i.* into intent from public.housecall_outbox o join public.housecall_intents i on i.id=o.intent_id where o.receipt_id=p_receipt_id and o.status<>'cancelled';
 if intent.id is null then
  if exists(select 1 from public.housecall_intents where receipt_id=p_receipt_id and payload_hash is not null) then return false; end if;
  return public.both_housecall_steps_succeeded_legacy(p_receipt_id);
 end if;
 if intent.payload_hash is null then return public.both_housecall_steps_succeeded_legacy(p_receipt_id); end if;
 if jsonb_array_length(intent.approved_images)=0 or jsonb_array_length(intent.attachment_job_ids)=0 or jsonb_array_length(intent.job_cost_lines)=0 then return false; end if;
 expected:=jsonb_array_length(intent.approved_images)*jsonb_array_length(intent.attachment_job_ids)+jsonb_array_length(intent.job_cost_lines);
 return (select count(*)=expected and bool_and(s.status='succeeded' and exists(select 1 from public.housecall_links l where l.export_step_id=s.id and l.intent_id=intent.id and l.external_id=s.external_id))
  from public.housecall_export_steps s where s.intent_id=intent.id);
end;$$;
revoke all on function public.both_housecall_steps_succeeded(uuid) from public,anon,authenticated;
grant execute on function public.both_housecall_steps_succeeded(uuid) to service_role;

create function public.clear_housecall_export_content() returns trigger language plpgsql security definer set search_path='' as $$
declare previous_purge_setting text:=coalesce(current_setting('svl.allow_purge',true),'');
begin
 if new.content_deleted_at is not null and old.content_deleted_at is null then
  perform set_config('svl.allow_purge','true',true);
  update public.housecall_export_steps set payload=null where receipt_id=new.id;
  update public.housecall_intents set approved_images='[]',approved_reference='' where receipt_id=new.id;
  update public.export_attempts set evidence='{}' where receipt_id=new.id;
  update public.housecall_write_approvals set reason='Content deleted',revoked_at=coalesce(revoked_at,now()) where intent_id in(select id from public.housecall_intents where receipt_id=new.id);
  perform set_config('svl.allow_purge',previous_purge_setting,true);
 end if;
 return new;
end;$$;
revoke all on function public.clear_housecall_export_content() from public,anon,authenticated,service_role;
create trigger receipts_clear_housecall_export_content before update of content_deleted_at on public.receipts for each row execute function public.clear_housecall_export_content();

-- Retry is a manager request for the exact unresolved step. It never creates a
-- new payload/version, expands a grant, or turns uncertain commit into absence.
create function public.request_housecall_step_retry(p_actor_id uuid,p_step_id uuid,p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.housecall_export_steps%rowtype; rec public.receipts%rowtype; ev public.export_attempts%rowtype;
begin
 perform public.require_active_actor(p_actor_id,array['manager','admin']);
 if length(btrim(coalesce(p_reason,''))) not between 1 and 2000 then raise exception 'invalid_request'; end if;
 select * into s from public.housecall_export_steps where id=p_step_id;
 select * into rec from public.receipts where id=s.receipt_id for update;
 select * into s from public.housecall_export_steps where id=p_step_id for update;
 if s.id is null or s.status in ('ready','in_progress','succeeded') or rec.content_deleted_at is not null or rec.purge_claimed_at is not null
  or not exists(select 1 from public.housecall_outbox where receipt_id=s.receipt_id and intent_id=s.intent_id and status<>'cancelled')
  or exists(select 1 from public.manager_recovery_commands where receipt_id=s.receipt_id and kind='correction' and status in ('pending','processing'))
  then raise exception 'conflict'; end if;
 if s.dispatch_count>=8 and s.status<>'reconcile_required' then raise exception 'attempt_limit_reached';end if;
 if s.status='permanent_failure' then
  select * into ev from public.export_attempts where export_step_id=s.id and status='permanent_failure' order by created_at desc,id desc limit 1;
  if s.dispatch_started_at is not null and (ev.evidence->>'definitive_rejection' is distinct from 'true' or coalesce(ev.evidence->>'http_status','') not in ('400','401','403','404','422','429')) then raise exception 'reconciliation_required'; end if;
  update public.housecall_export_steps set status='retryable_failure',last_error=null where id=s.id returning * into s;
 end if;
 update public.work_items set status='queued',next_attempt_at=now(),lease_owner=null,lease_expires_at=null,last_error=null,terminal_reason=null where receipt_id=s.receipt_id and kind='export';
 perform public.append_audit_event(s.receipt_id,'work_retried',null,jsonb_build_object('step_id',s.id,'status',s.status),
  jsonb_build_object('reason',btrim(p_reason),'reconcile_only',s.status='reconcile_required'),'user',p_actor_id);
 return jsonb_build_object('stepId',s.id,'status',s.status,'reconcileOnly',s.status='reconcile_required');
end;$$;
revoke all on function public.request_housecall_step_retry(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.request_housecall_step_retry(uuid,uuid,text) to service_role;

alter function public.manager_recovery_command(uuid,uuid,uuid,text,uuid,text,jsonb) rename to manager_recovery_command_before_ra6;
create function public.manager_recovery_command(p_receipt_id uuid,p_actor_id uuid,p_intent_id uuid,p_kind text,p_attempt_id uuid,p_reason text,p_snapshot jsonb default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare attempt public.export_attempts%rowtype; s public.housecall_export_steps%rowtype; rec public.receipts%rowtype; command_id uuid;
begin
 if p_kind='retry' then
  select * into attempt from public.export_attempts where id=p_attempt_id and receipt_id=p_receipt_id and intent_id=p_intent_id;
  if attempt.export_step_id is not null then
   -- RA-6 page identities must be checked before the legacy receipt/job/line
   -- rules: a successful first page does not prohibit retrying the second page.
   perform public.require_active_actor(p_actor_id,array['manager','admin']);
   if length(btrim(coalesce(p_reason,''))) not between 1 and 2000 or p_snapshot is not null then raise exception 'invalid_request'; end if;
   perform set_config('svl.actor_id',p_actor_id::text,true);
   perform set_config('svl.correlation_id',gen_random_uuid()::text,true);
   select * into rec from public.receipts where id=p_receipt_id for update;
   select * into s from public.housecall_export_steps where id=attempt.export_step_id and receipt_id=p_receipt_id and intent_id=p_intent_id;
   if s.id is null or rec.content_deleted_at is not null or rec.purge_claimed_at is not null
    or rec.status not in ('approved','exporting','exported','partial_success','failed')
    or not exists(select 1 from public.housecall_outbox where receipt_id=p_receipt_id and intent_id=p_intent_id and status<>'cancelled')
    or attempt.status not in ('retryable_failure','permanent_failure')
    or exists(select 1 from public.export_attempts a where a.export_step_id=s.id and
      (a.status='succeeded' or (a.created_at,a.id)>(attempt.created_at,attempt.id)))
    or exists(select 1 from public.housecall_links l where l.export_step_id=s.id)
    then raise exception 'conflict'; end if;
   select id into command_id from public.manager_recovery_commands where attempt_id=attempt.id and status in ('pending','processing');
   if command_id is not null then return jsonb_build_object('id',command_id,'status','pending','stepId',s.id); end if;
   insert into public.manager_recovery_commands(receipt_id,actor_id,intent_id,kind,attempt_id,reason)
    values(p_receipt_id,p_actor_id,p_intent_id,'retry',attempt.id,btrim(p_reason)) returning id into command_id;
   perform public.request_housecall_step_retry(p_actor_id,s.id,p_reason);
   -- The durable step now owns recovery. The command records the request, not
   -- an external success, and cannot later replay a completed step.
   update public.manager_recovery_commands set status='completed' where id=command_id;
   perform public.append_audit_event(p_receipt_id,'work_retried',null,jsonb_build_object('command_id',command_id,'intent_id',p_intent_id),
    jsonb_build_object('decision','retry','attempt_id',attempt.id,'step_id',s.id),'user',p_actor_id);
   return jsonb_build_object('id',command_id,'status','completed','stepId',s.id);
  end if;
 end if;
 if p_kind='correction' then
  perform public.require_active_actor(p_actor_id,array['admin']);
  -- Share the same receipt lock as claim/dispatch. Generic work_items leases do
  -- not represent RA-6 HTTP activity, and expiry does not prove no commit.
  perform id from public.receipts where id=p_receipt_id for update;
  if exists(select 1 from public.housecall_export_steps where receipt_id=p_receipt_id and status in ('in_progress','reconcile_required'))
   then raise exception 'conflict'; end if;
 end if;
 return public.manager_recovery_command_before_ra6(p_receipt_id,p_actor_id,p_intent_id,p_kind,p_attempt_id,p_reason,p_snapshot);
end;$$;
revoke all on function public.manager_recovery_command(uuid,uuid,uuid,text,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.manager_recovery_command(uuid,uuid,uuid,text,uuid,text,jsonb) to service_role;

-- Each approved image is an independent step; a successful first page must not
-- hide a failed second page in manager recovery/history.
create or replace function public.manager_current_export_attempts(p_receipt_id uuid,p_intent_id uuid)
returns setof public.export_attempts language plpgsql stable security invoker set search_path='' as $$
begin
 if public.current_user_role() not in ('manager','admin') or not public.caller_is_active() then raise exception 'forbidden'; end if;
 return query select distinct on(coalesce(a.export_step_id::text,concat(a.housecall_job_id,':',a.step,':',a.receipt_line_id))) a.*
  from public.export_attempts a where a.receipt_id=p_receipt_id and a.intent_id=p_intent_id
  order by coalesce(a.export_step_id::text,concat(a.housecall_job_id,':',a.step,':',a.receipt_line_id)),(a.status='succeeded') desc,a.created_at desc,a.id desc limit 600;
end;$$;
revoke all on function public.manager_current_export_attempts(uuid,uuid) from public,anon,authenticated;
grant execute on function public.manager_current_export_attempts(uuid,uuid) to authenticated;

create function public.list_ready_housecall_exports(p_limit integer default 20)
returns table(receipt_id uuid,intent_id uuid) language plpgsql stable security definer set search_path='' as $$
begin
 if p_limit is null or p_limit not between 1 and 100 then raise exception 'invalid_request'; end if;
 return query select o.receipt_id,o.intent_id from public.housecall_outbox o
  join public.receipts r on r.id=o.receipt_id
  join public.housecall_intents i on i.id=o.intent_id
  join lateral (select max(s.updated_at) as last_attempt,bool_or(s.status in ('reconcile_required','in_progress')) as reconciliation
   from public.housecall_export_steps s where s.intent_id=o.intent_id and
    (s.status in ('ready','retryable_failure','reconcile_required') or (s.status='in_progress' and s.lease_expires_at<=now()))) active on active.last_attempt is not null
  where o.status='pending' and r.status in ('approved','exporting','partial_success','failed')
   and r.content_deleted_at is null and r.purge_claimed_at is null and i.payload_hash is not null and jsonb_array_length(i.approved_images)>0
   and not exists(select 1 from public.manager_recovery_commands c where c.receipt_id=r.id and c.kind='correction' and c.status in ('pending','processing'))
   and exists(select 1 from public.housecall_write_approvals g where g.intent_id=o.intent_id and g.payload_hash=i.payload_hash
    and g.revoked_at is null and g.expires_at>now() and (g.used_writes<g.max_writes or active.reconciliation))
  order by active.last_attempt,o.created_at,o.id limit p_limit;
end;$$;
revoke all on function public.list_ready_housecall_exports(integer) from public,anon,authenticated;
grant execute on function public.list_ready_housecall_exports(integer) to service_role;
