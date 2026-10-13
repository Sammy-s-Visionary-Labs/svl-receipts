-- Worker report imports must validate their lease at the commit point, after any
-- wait for the shared ledger row. Manager and control CAS calls retain their API.
create function public.compare_and_swap_labor_state_leased(
 p_expected_revision bigint,p_control jsonb,p_manifest jsonb,p_changed_imports jsonb,
 p_lease_token text,p_command_id text,p_period_start date,p_period_end date
) returns bigint language plpgsql security invoker set search_path='' as $$
declare current_state public.labor_state%rowtype; lease_expires_at timestamptz;
begin
 if p_expected_revision is null or p_expected_revision<0 or p_control is null
  or jsonb_typeof(p_control)<>'object' or p_lease_token is null
  or p_lease_token !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  or p_command_id is null
  or p_command_id !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  or p_period_start is null or p_period_end is null or p_period_start>p_period_end
 then raise exception 'invalid_labor_import_lease_guard' using errcode='22023'; end if;
 select * into current_state from public.labor_state where singleton for update;
 if not found then raise exception 'labor_state_unavailable'; end if;
 if current_state.revision<>p_expected_revision then return null; end if;
 lease_expires_at:=nullif(current_state.control#>>'{workerLease,expiresAt}','')::timestamptz;
 if current_state.control#>>'{workerLease,leaseToken}' is distinct from p_lease_token
  or current_state.control#>>'{workerLease,commandId}' is distinct from p_command_id
  or current_state.control#>>'{sync,commandId}' is distinct from p_command_id
  or current_state.control#>>'{sync,status}' is distinct from 'running'
  or lease_expires_at is null or lease_expires_at<=clock_timestamp()
  or current_state.control#>>'{workerLease,period,from}' is distinct from p_period_start::text
  or current_state.control#>>'{workerLease,period,to}' is distinct from p_period_end::text
  or p_control#>>'{workerLease,leaseToken}' is distinct from p_lease_token
  or p_control#>>'{workerLease,commandId}' is distinct from p_command_id
  or p_control#>>'{sync,commandId}' is distinct from p_command_id
  or p_control#>>'{sync,status}' is distinct from 'running'
  or p_control#>>'{workerLease,period,from}' is distinct from p_period_start::text
  or p_control#>>'{workerLease,period,to}' is distinct from p_period_end::text
 then return null; end if;
 -- The nested CAS reuses this transaction's row lock, preserving atomic revision,
 -- source delta, provenance and audit behavior without duplicating that machinery.
 return public.compare_and_swap_labor_state(
  p_expected_revision,p_control,p_manifest,p_changed_imports,null
 );
end;
$$;

revoke all on function public.compare_and_swap_labor_state_leased(bigint,jsonb,jsonb,jsonb,text,text,date,date)
 from public,anon,authenticated;
grant execute on function public.compare_and_swap_labor_state_leased(bigint,jsonb,jsonb,jsonb,text,text,date,date)
 to service_role;
