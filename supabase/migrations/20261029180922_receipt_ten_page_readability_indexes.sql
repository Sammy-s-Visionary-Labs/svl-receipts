-- Keep readability evidence aligned with the ten-page receipt limit.
-- Retain exact JSON-type checks and validation against confirmed page count.
set local lock_timeout = '5s';

alter table public.readability_checks
  drop constraint readability_checks_failed_page_indexes_check;
alter table public.readability_checks
  add constraint readability_checks_failed_page_indexes_check
  check (failed_page_indexes <@ array[0, 1, 2, 3, 4, 5, 6, 7, 8, 9]::smallint[]);

do $$
declare
  definition text;
  old_limit constant text := $old$item.value::text not in ('0', '1', '2', '3', '4')$old$;
  new_limit constant text := $new$item.value::text not in ('0', '1', '2', '3', '4', '5', '6', '7', '8', '9')$new$;
begin
  select pg_get_functiondef('public.record_readability_result(uuid,text,jsonb,text,text,jsonb)'::regprocedure)
    into definition;
  if (length(definition) - length(replace(definition, old_limit, ''))) / length(old_limit) <> 1 then
    raise exception 'Expected exactly one five-page readability index limit';
  end if;
  execute replace(definition, old_limit, new_limit);
end;
$$;
