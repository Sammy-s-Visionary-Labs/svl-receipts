-- Email originals have no public/worker storage policy. Only the importer and
-- authenticated manager download endpoint may read them.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('receipt-emails','receipt-emails',false,41943040,array['message/rfc822','application/octet-stream'])
on conflict(id) do nothing;
create table public.email_receipt_imports (
 id uuid primary key default gen_random_uuid(),
 mailbox text not null check(mailbox='recisvl@gmail.com'),
 message_id text not null check(message_id ~ '^[a-zA-Z0-9_-]{1,128}$'),
 checksum text not null check(checksum ~ '^[a-f0-9]{64}$'),
 byte_size integer not null check(byte_size between 1 and 41943040),
 owner_user_id uuid not null references public.profiles(id),
 status text not null default 'awaiting_upload' check(status in ('awaiting_upload','queued','processing','imported','needs_attention')),
 sender text, subject text, received_at timestamptz,
 lease_token uuid, lease_until timestamptz, attempts integer not null default 0,
 last_error text, next_attempt_at timestamptz not null default now(),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(mailbox,message_id)
);
create index email_import_work_idx on public.email_receipt_imports(status,next_attempt_at);
create index email_import_owner_idx on public.email_receipt_imports(owner_user_id);
create table public.email_receipt_documents (
 receipt_id uuid primary key references public.receipts(id),
 import_id uuid not null references public.email_receipt_imports(id),
 part_index integer not null check(part_index between 0 and 19),
 filename text not null check(length(filename)<=255),
 unique(import_id,part_index)
);
create index email_documents_import_idx on public.email_receipt_documents(import_id);
alter table public.email_receipt_imports enable row level security;
alter table public.email_receipt_documents enable row level security;
revoke all on public.email_receipt_imports,public.email_receipt_documents from public,anon,authenticated;
grant select on public.email_receipt_imports,public.email_receipt_documents to authenticated;
grant all on public.email_receipt_imports,public.email_receipt_documents to service_role;
create policy email_import_staff on public.email_receipt_imports for select to authenticated
 using((select public.current_user_role()) in ('manager','admin') and (select public.caller_is_active()));
create policy email_documents_staff on public.email_receipt_documents for select to authenticated
 using((select public.current_user_role()) in ('manager','admin') and (select public.caller_is_active()));

create function public.claim_email_receipt_import(p_id uuid) returns setof public.email_receipt_imports
language sql security invoker set search_path='' as $$
 update public.email_receipt_imports set status='processing',lease_token=gen_random_uuid(),
 lease_until=now()+interval '5 minutes',attempts=attempts+1,updated_at=now()
 where id=p_id and (status='queued' or (status='processing' and lease_until<now()))
 and next_attempt_at<=now() returning *;
$$;
create function public.commit_email_receipts(p_import_id uuid,p_lease_token uuid,p_documents jsonb,p_sender text,p_subject text,p_received_at timestamptz)
returns void language plpgsql security invoker set search_path='' as $$
declare item public.email_receipt_imports%rowtype; doc jsonb; page jsonb; pages jsonb; idx integer:=0;
begin
 select * into item from public.email_receipt_imports where id=p_import_id for update;
 if item.status<>'processing' or item.lease_token is distinct from p_lease_token or item.lease_until<now() then raise exception 'conflict_email_lease'; end if;
 perform public.require_active_actor(item.owner_user_id,array['manager','admin']);
 if jsonb_typeof(p_documents)<>'array' or jsonb_array_length(p_documents) not between 1 and 20 then raise exception 'invalid_request'; end if;
 for doc in select value from jsonb_array_elements(p_documents) loop
  for page in select value from jsonb_array_elements(doc->'pages') loop
   if not starts_with(page->>'storageKey',item.owner_user_id::text||'/'||(doc->>'receiptId')||'/') then raise exception 'invalid_request'; end if;
  end loop;
  perform public.create_upload_pending_receipt_set(item.owner_user_id,(doc->>'receiptId')::uuid,doc->'pages');
  select jsonb_agg(jsonb_build_object('pageIndex',value->'pageIndex','checksum',value->'checksum','byteSize',value->'byteSize') order by (value->>'pageIndex')::integer)
   into pages from jsonb_array_elements(doc->'pages');
  perform public.submit_confirmed_receipt_set((doc->>'receiptId')::uuid,item.owner_user_id,pages,doc->>'manifestChecksum',(doc->>'totalBytes')::integer);
  insert into public.email_receipt_documents(receipt_id,import_id,part_index,filename)
   values((doc->>'receiptId')::uuid,item.id,idx,left(doc->>'filename',255));
  idx:=idx+1;
 end loop;
 update public.email_receipt_imports set status='imported',sender=left(p_sender,320),subject=left(p_subject,500),received_at=p_received_at,
  last_error=null,lease_token=null,lease_until=null,updated_at=now() where id=item.id;
end;$$;

-- Refresh at review time as well as extraction time: two concurrent extractions
-- may not have seen each other. Approval repeats the comparison under a lock.
create function public.refresh_receipt_duplicate_candidates(p_receipt_id uuid,p_snapshot jsonb default null)
returns void language plpgsql security invoker set search_path='' as $$
declare candidate record;
begin
 for candidate in
 with latest as (
  select r.id,r.checksum,
   public.normalize_receipt_match_text(coalesce(case when r.id=p_receipt_id then p_snapshot->>'vendor' end,v.snapshot->>'vendor',e.vendor)) vendor,
   coalesce(case when r.id=p_receipt_id then p_snapshot->>'purchaseDate' end,v.snapshot->>'purchaseDate',e.purchase_date) purchase_date,
   coalesce(case when r.id=p_receipt_id then p_snapshot->>'referenceTotal' end,v.snapshot->>'referenceTotal',(e.receipt_total_cents::numeric/100)::text) total,
   replace(public.normalize_receipt_match_text(coalesce(case when r.id=p_receipt_id then p_snapshot->>'invoiceNumber' end,v.snapshot->>'invoiceNumber',e.invoice_number)),' ','') invoice,
   replace(public.normalize_receipt_match_text(coalesce(case when r.id=p_receipt_id then p_snapshot->>'ticketNumber' end,v.snapshot->>'ticketNumber',e.ticket_number)),' ','') ticket
  from public.receipts r
  left join lateral(select * from public.extractions where receipt_id=r.id order by created_at desc,id desc limit 1)e on true
  left join lateral(select * from public.reviews where receipt_id=r.id and snapshot is not null order by version desc nulls last,created_at desc,id desc limit 1)v on true
  where r.submitted_at is not null and r.content_deleted_at is null and r.purge_claimed_at is null and r.status not in ('rejected','rejected_unreadable','duplicate')
 ) select other.id from latest cur join latest other on other.id<>cur.id where cur.id=p_receipt_id and (
  (cur.checksum is not null and cur.checksum=other.checksum)
  or (cur.vendor<>'' and cur.vendor=other.vendor and (
   (cur.invoice<>'' and cur.invoice=other.invoice) or (cur.ticket<>'' and cur.ticket=other.ticket)
   or (cur.purchase_date<>'' and cur.purchase_date=other.purchase_date
    and cur.total ~ '^[0-9]+(\.[0-9]{1,2})?$' and other.total ~ '^[0-9]+(\.[0-9]{1,2})?$'
    and case when cur.total ~ '^[0-9]+(\.[0-9]{1,2})?$' and other.total ~ '^[0-9]+(\.[0-9]{1,2})?$' then cur.total::numeric=other.total::numeric else false end
    and not(cur.invoice<>'' and other.invoice<>'' and cur.invoice<>other.invoice)
    and not(cur.ticket<>'' and other.ticket<>'' and cur.ticket<>other.ticket)))))
 loop
  insert into public.duplicate_candidates(receipt_id,candidate_receipt_id,score,reasons,scoring_version)
   values(p_receipt_id,candidate.id,100,'[{"code":"cross_source_match","message":"Matching receipt file, transaction reference, or vendor/date/total. Compare the originals before approval."}]','email-review-v1')
   on conflict(receipt_id,candidate_receipt_id) do nothing;
 end loop;
end;$$;
create function public.guard_duplicate_approval() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if new.decision='approve' then
  perform pg_advisory_xact_lock(714221908);
  perform public.refresh_receipt_duplicate_candidates(new.receipt_id,new.snapshot);
  if exists(select 1 from public.duplicate_candidates c where (c.receipt_id=new.receipt_id or c.candidate_receipt_id=new.receipt_id)
   and c.status in ('pending','confirmed')
   and exists(select 1 from public.receipts r where r.id=case when c.receipt_id=new.receipt_id then c.candidate_receipt_id else c.receipt_id end and r.status not in ('duplicate','rejected','rejected_unreadable'))
   and not exists(select 1 from public.duplicate_candidates d where d.status='dismissed' and
    ((d.receipt_id=c.receipt_id and d.candidate_receipt_id=c.candidate_receipt_id) or (d.receipt_id=c.candidate_receipt_id and d.candidate_receipt_id=c.receipt_id))))
  then raise exception 'duplicate_review_required'; end if;
 end if;
 return new;
end;$$;
create trigger reviews_zz_duplicate_approval_guard before insert on public.reviews for each row execute function public.guard_duplicate_approval();
revoke all on function public.claim_email_receipt_import(uuid),public.commit_email_receipts(uuid,uuid,jsonb,text,text,timestamptz),
 public.refresh_receipt_duplicate_candidates(uuid,jsonb),public.guard_duplicate_approval() from public,anon,authenticated;
grant execute on function public.claim_email_receipt_import(uuid),public.commit_email_receipts(uuid,uuid,jsonb,text,text,timestamptz),
 public.refresh_receipt_duplicate_candidates(uuid,jsonb) to service_role;

-- A shared email is retained until every receipt it supplied has completed the
-- existing content-retention lifecycle. Keep message identity as a replay fence.
alter table public.email_receipt_imports add column raw_deleted_at timestamptz;
create function public.purgeable_email_originals() returns table(id uuid)
language sql stable security invoker set search_path='' as $$
 select i.id from public.email_receipt_imports i where i.status='imported' and i.raw_deleted_at is null
 and exists(select 1 from public.email_receipt_documents d where d.import_id=i.id)
 and not exists(select 1 from public.email_receipt_documents d join public.receipts r on r.id=d.receipt_id where d.import_id=i.id and r.content_deleted_at is null)
 order by i.created_at limit 20;
$$;
create function public.retire_email_original(p_id uuid) returns void
language plpgsql security invoker set search_path='' as $$
begin
 if not exists(select 1 from public.purgeable_email_originals() where id=p_id) then raise exception 'conflict';end if;
 update public.email_receipt_imports set raw_deleted_at=now(),sender=null,subject=null,received_at=null where id=p_id;
 update public.email_receipt_documents set filename='Receipt content removed' where import_id=p_id;
end;$$;
revoke all on function public.purgeable_email_originals(),public.retire_email_original(uuid) from public,anon,authenticated;
grant execute on function public.purgeable_email_originals(),public.retire_email_original(uuid) to service_role;

-- Non-readable transaction fingerprints outlive image retention. They prevent
-- an old exported purchase being re-entered after its source pages are purged.
create table public.receipt_purchase_fingerprints (
 fingerprint text not null,receipt_id uuid not null references public.receipts(id),
 primary key(fingerprint,receipt_id)
);
create index purchase_fingerprint_receipt_idx on public.receipt_purchase_fingerprints(receipt_id);
alter table public.receipt_purchase_fingerprints enable row level security;
revoke all on public.receipt_purchase_fingerprints from public,anon,authenticated;
grant all on public.receipt_purchase_fingerprints to service_role;
create function public.receipt_purchase_keys(p_snapshot jsonb,p_checksum text) returns setof text
language sql immutable security invoker set search_path='' as $$
 select encode(sha256(convert_to(k::text,'UTF8')),'hex') from (
  select jsonb_build_array('invoice',public.normalize_receipt_match_text(p_snapshot->>'vendor'),replace(public.normalize_receipt_match_text(p_snapshot->>'invoiceNumber'),' ','')) k
  where public.normalize_receipt_match_text(p_snapshot->>'vendor')<>'' and public.normalize_receipt_match_text(p_snapshot->>'invoiceNumber')<>''
  union all
  select jsonb_build_array('ticket',public.normalize_receipt_match_text(p_snapshot->>'vendor'),replace(public.normalize_receipt_match_text(p_snapshot->>'ticketNumber'),' ',''))
  where public.normalize_receipt_match_text(p_snapshot->>'vendor')<>'' and public.normalize_receipt_match_text(p_snapshot->>'ticketNumber')<>''
  union all select jsonb_build_array('file',p_checksum) where p_checksum is not null
 ) keys;
$$;
insert into public.receipt_purchase_fingerprints(fingerprint,receipt_id)
 select k,r.id from public.receipts r join public.reviews v on v.receipt_id=r.id and v.decision='approve'
 cross join lateral public.receipt_purchase_keys(v.snapshot,r.checksum) k on conflict do nothing;
create function public.guard_retained_purchase_identity() returns trigger
language plpgsql security invoker set search_path='' as $$
declare keys text[];
begin
 if new.decision<>'approve' then return new;end if;
 perform pg_advisory_xact_lock(714221908);
 select array_agg(k) into keys from public.receipt_purchase_keys(new.snapshot,(select checksum from public.receipts where id=new.receipt_id)) k;
 if exists(select 1 from public.receipt_purchase_fingerprints f join public.receipts r on r.id=f.receipt_id
  where f.fingerprint=any(keys) and r.id<>new.receipt_id and r.content_deleted_at is not null
  and r.status in ('approved','exporting','exported','partial_success')) then raise exception 'retained_purchase_duplicate';end if;
 insert into public.receipt_purchase_fingerprints(fingerprint,receipt_id) select unnest(keys),new.receipt_id on conflict do nothing;
 return new;
end;$$;
create trigger reviews_zzz_retained_purchase_guard before insert on public.reviews for each row execute function public.guard_retained_purchase_identity();
revoke all on function public.receipt_purchase_keys(jsonb,text),public.guard_retained_purchase_identity() from public,anon,authenticated;
grant execute on function public.receipt_purchase_keys(jsonb,text) to service_role;
