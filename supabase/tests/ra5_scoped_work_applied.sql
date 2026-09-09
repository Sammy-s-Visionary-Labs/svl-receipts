-- Receipt-scoped immediacy: queue backlog, competing leases and retries cannot
-- redirect a confirmation kick to another receipt. All fixtures roll back.
begin;
insert into auth.users(id,aud,role,email) values('56000000-0000-4000-8000-000000000001','authenticated','authenticated','ra5-scoped@example.invalid');
insert into public.receipts(id,owner_user_id,status,submitted_at) values
 ('56100000-0000-4000-8000-000000000001','56000000-0000-4000-8000-000000000001','submitted',now()-interval '2 days'),
 ('56100000-0000-4000-8000-000000000002','56000000-0000-4000-8000-000000000001','submitted',now()),
 ('56100000-0000-4000-8000-000000000003','56000000-0000-4000-8000-000000000001','processing',now());
insert into public.receipt_pages(receipt_id,page_index,storage_key,content_type,checksum,byte_size,confirmed_at)
 values('56100000-0000-4000-8000-000000000002',0,'56000000-0000-4000-8000-000000000001/56100000-0000-4000-8000-000000000002/page-0.jpg','image/jpeg',repeat('e',64),100,now());
insert into public.work_items(receipt_id,kind,status,next_attempt_at) values
 ('56100000-0000-4000-8000-000000000001','readability','queued',now()-interval '2 days'),
 ('56100000-0000-4000-8000-000000000001','extract','queued',now()-interval '2 days'),
 ('56100000-0000-4000-8000-000000000002','readability','queued',now()),
 ('56100000-0000-4000-8000-000000000003','extract','queued',now());
set local role service_role;
do $$
declare item public.work_items%rowtype; own uuid:='56100000-0000-4000-8000-000000000002';
begin
 select * into item from public.claim_receipt_work(own,'scoped-one','readability',300);
 if item.receipt_id is distinct from own or item.kind<>'readability' or item.attempt_count<>1 then raise exception 'scoped claim followed backlog';end if;
 if exists(select 1 from public.claim_receipt_work(own,'scoped-two','readability',300)) then raise exception 'live lease stolen';end if;
 if exists(select 1 from public.work_items where receipt_id='56100000-0000-4000-8000-000000000001' and status<>'queued') then raise exception 'unrelated backlog mutated';end if;
 update public.work_items set lease_expires_at=now()-interval '1 second' where id=item.id;
 select * into item from public.claim_receipt_work(own,'scoped-two','readability',300);
 if item.lease_owner<>'scoped-two' or item.attempt_count<>2 then raise exception 'expired lease not recovered';end if;
 perform public.start_queued_work(item.id,'scoped-two');
 perform public.record_readability_result(item.id,'scoped-two','{"schema_version":1,"readable":true}','google_gemini','test-flash','{}');
 perform public.complete_work(item.id,'scoped-two');
 select * into item from public.claim_receipt_work(own,'scoped-two','extract',300);
 if item.receipt_id is distinct from own or item.kind<>'extract' or item.generation<>1 then raise exception 'accepted receipt not immediately extractable';end if;
 if exists(select 1 from public.claim_receipt_work('56100000-0000-4000-8000-000000000003','scoped-one','extract',300)) then raise exception 'unaccepted extraction claimed';end if;
 perform public.fail_work(item.id,'scoped-two','provider_rate_limited',true);
 if exists(select 1 from public.claim_receipt_work(own,'scoped-two','extract',300)) then raise exception 'backoff bypassed';end if;
 update public.work_items set next_attempt_at=now() where id=item.id;
 select * into item from public.claim_receipt_work(own,'scoped-three','extract',300);
 if item.id is null then raise exception 'due retry omitted';end if;
 begin perform public.release_receipt_work(item.id,'other-worker');raise exception 'foreign lease released';exception when others then if sqlerrm<>'conflict' then raise;end if;end;
 item:=public.release_receipt_work(item.id,'scoped-three');
 if item.status<>'queued' or item.lease_owner is not null or item.lease_expires_at is not null or item.attempt_count<>1 or item.next_attempt_at>now() then raise exception 'budget release delayed work or spent attempt';end if;
 if not exists(select 1 from public.claim_receipt_work(own,'scoped-four','extract',300)) then raise exception 'budget released work not immediately claimable';end if;
 begin perform public.claim_receipt_work(own,'scoped-one','export',300);raise exception 'export scope accepted';exception when others then if sqlerrm<>'invalid_request' then raise;end if;end;
 begin perform public.claim_receipt_work(own,'scoped-one','extract',301);raise exception 'unbounded lease accepted';exception when others then if sqlerrm<>'invalid_request' then raise;end if;end;
 if not exists(select 1 from public.audit_events where receipt_id=own and action='work_started' and actor_type='worker') then raise exception 'claim audit missing';end if;
end;$$;
reset role;
do $$begin
 if has_function_privilege('anon','public.claim_receipt_work(uuid,text,text,integer)','EXECUTE') or has_function_privilege('authenticated','public.claim_receipt_work(uuid,text,text,integer)','EXECUTE') then raise exception 'public scoped worker exposed';end if;
 if has_function_privilege('anon','public.release_receipt_work(uuid,text)','EXECUTE') or has_function_privilege('authenticated','public.release_receipt_work(uuid,text)','EXECUTE') then raise exception 'public stage release exposed';end if;
end;$$;
rollback;
