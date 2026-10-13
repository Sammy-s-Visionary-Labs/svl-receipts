-- Session bytes upload outside a database transaction. Fence the final pointer change
-- against the current labor lease while holding the same ledger lock as control writes.
-- Remove the previous overload so service callers cannot bypass the lease check.
drop function public.compare_and_swap_labor_worker_session(bigint,text,text);

create function public.compare_and_swap_labor_worker_session(
 p_expected_version bigint,p_object_key text,p_content_sha256 text,p_lease_token text default null
) returns bigint language plpgsql security invoker set search_path='' as $$
declare current_control jsonb; current_version bigint; lease_expires_at timestamptz;
begin
 if p_expected_version is null or p_expected_version<0 or p_object_key is null
  or p_object_key !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.bin$'
  or p_content_sha256 is null or p_content_sha256 !~ '^[a-f0-9]{64}$'
 then raise exception 'invalid_labor_worker_session' using errcode='22023'; end if;
 select control into current_control from public.labor_state where singleton for update;
 if not found then raise exception 'labor_state_unavailable'; end if;
 lease_expires_at:=nullif(current_control#>>'{workerLease,expiresAt}','')::timestamptz;
 if p_lease_token is not null then
  if p_lease_token='' or current_control#>>'{workerLease,leaseToken}' is distinct from p_lease_token
   or lease_expires_at is null or lease_expires_at<=clock_timestamp()
   or current_control#>>'{sync,status}' is distinct from 'running'
   or current_control#>>'{workerLease,commandId}' is null
   or current_control#>>'{sync,commandId}' is distinct from current_control#>>'{workerLease,commandId}'
  then return null; end if;
 else
  if current_control#>>'{sync,command}' is distinct from 'connect'
   or (lease_expires_at is not null and lease_expires_at>clock_timestamp())
  then return null; end if;
 end if;
 select version into current_version from public.labor_worker_sessions where singleton for update;
 if not found then raise exception 'labor_worker_session_unavailable'; end if;
 if current_version<>p_expected_version then return null; end if;
 if current_version>=9007199254740991 then raise exception 'labor_session_version_limit'; end if;
 if not exists(select 1 from storage.objects where bucket_id='labor-worker-sessions' and name=p_object_key)
 then raise exception 'labor_worker_session_upload_missing'; end if;
 update public.labor_worker_sessions set version=current_version+1,object_key=p_object_key,
  content_sha256=p_content_sha256,updated_at=clock_timestamp() where singleton;
 return current_version+1;
end;
$$;

revoke all on function public.compare_and_swap_labor_worker_session(bigint,text,text,text)
 from public,anon,authenticated;
grant execute on function public.compare_and_swap_labor_worker_session(bigint,text,text,text)
 to service_role;
