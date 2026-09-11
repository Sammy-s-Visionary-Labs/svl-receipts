-- Administrator health history contains only timestamps and classified codes.
create table public.housecall_health_state (
 id boolean primary key default true check(id),
 checked_at timestamptz,
 last_success_at timestamptz,
 last_error text
);
alter table public.housecall_health_state enable row level security;
revoke all on public.housecall_health_state from public,anon,authenticated,service_role;
grant select,update on public.housecall_health_state to service_role;
insert into public.housecall_health_state(id) values(true);
create function public.housecall_health_status(p_connected boolean default null,p_error text default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare state public.housecall_health_state%rowtype;
begin
 if p_connected is not null then
  if (p_connected and p_error is not null) or (not p_connected and (p_error is null or p_error not in ('configuration','authentication','forbidden','not_found','rate_limited','provider_rejected','provider_unavailable','invalid_response','network','timeout','unsafe_destination','connection_failed'))) then raise exception 'invalid_request'; end if;
  update public.housecall_health_state set checked_at=clock_timestamp(),last_success_at=case when p_connected then clock_timestamp() else last_success_at end,last_error=p_error where id;
 end if;
 select * into state from public.housecall_health_state where id;
 return jsonb_build_object('checkedAt',state.checked_at,'lastSuccessfulCheckAt',state.last_success_at,'lastError',state.last_error);
end;$$;
revoke all on function public.housecall_health_status(boolean,text) from public,anon,authenticated;
grant execute on function public.housecall_health_status(boolean,text) to service_role;
