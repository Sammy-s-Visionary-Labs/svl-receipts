-- RA-43: use current availability at approval and expose a bounded local
-- active/recent catalog window. Provider synchronization remains complete.
create function public.validate_housecall_review_destinations() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if new.decision='approve' and jsonb_typeof(new.snapshot->'lines')='array' and exists(
  select 1 from jsonb_array_elements(new.snapshot->'lines') line
  join public.manager_job_catalog job on job.id=line->>'jobId'
  where job.unavailable
 ) then raise exception using errcode='23514',message='invalid_request_job_unavailable'; end if;
 return new;
end;$$;
revoke all on function public.validate_housecall_review_destinations() from public,anon,authenticated,service_role;
create trigger reviews_validate_housecall_destinations before insert on public.reviews
 for each row execute function public.validate_housecall_review_destinations();

-- This new name avoids changing the RA-4 search signature or accidentally
-- choosing a PostgREST overload. Return the complete catalog row so freshness
-- and immutable IDs remain available to the manager response mapper.
create function public.manager_search_housecall_jobs(
 p_search text default '',p_active boolean default true,p_limit integer default 50,
 p_recent_since timestamptz default now()-interval '30 days',
 p_upcoming_until timestamptz default now()+interval '90 days'
) returns setof public.manager_job_catalog
language plpgsql stable security invoker set search_path='' as $$
begin
 if coalesce(public.current_user_role(),'') not in ('manager','admin') or not public.caller_is_active() then raise exception 'forbidden'; end if;
 if p_search is null or length(p_search)>120 or p_active is null or p_limit is null or p_limit not between 1 and 50
  or p_recent_since is null or p_upcoming_until is null or not isfinite(p_recent_since) or not isfinite(p_upcoming_until)
  or p_recent_since>p_upcoming_until
  -- One day of bound tolerance permits a configured 365-day window despite
  -- client/server clock differences; application configuration caps at 365.
  or p_recent_since<now()-interval '366 days' or p_recent_since>now()+interval '5 seconds'
  or p_upcoming_until>now()+interval '366 days' or p_upcoming_until<now()-interval '5 seconds'
  then raise exception 'invalid_request'; end if;
 return query select j.* from public.manager_job_catalog j where
  (not p_active or (not j.unavailable and (
   (j.active and (j.scheduled_at is null
     or lower(replace(coalesce(j.status,''),'_',' ')) in ('in progress','needs scheduling','unscheduled')
     or j.scheduled_at between p_recent_since and p_upcoming_until))
   or (not j.active and lower(coalesce(j.status,'')) ~ '^(complete|completed)( |$)'
     and j.scheduled_at between p_recent_since and p_upcoming_until)
  )))
  -- strpos treats %, _, quotes, and backslashes as literal search data.
  and (p_search='' or strpos(lower(concat_ws(' ',j.id,j.label,j.customer,j.job_number,j.service_address)),lower(p_search))>0)
  order by j.scheduled_at desc nulls last,j.id limit p_limit;
end;$$;
revoke all on function public.manager_search_housecall_jobs(text,boolean,integer,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.manager_search_housecall_jobs(text,boolean,integer,timestamptz,timestamptz) to authenticated;
