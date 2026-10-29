-- Raise the page count only; retain byte budgets, ownership, confirmation,
-- idempotency, and approval/export checks in the current RPC definitions.
set local lock_timeout = '5s';

alter table public.receipt_pages drop constraint receipt_pages_page_index_check;
alter table public.receipt_pages add constraint receipt_pages_page_index_check
  check (page_index >= 0 and page_index < 10);

do $$
declare
  signature text;
  definition text;
  old_limit constant text := 'jsonb_array_length(p_pages) > 5';
  new_limit constant text := 'jsonb_array_length(p_pages) > 10';
begin
  foreach signature in array array[
    'public.create_upload_pending_receipt_set(uuid,uuid,jsonb,double precision,double precision,double precision,timestamp with time zone,uuid)',
    'public.submit_confirmed_receipt_set(uuid,uuid,jsonb,text,bigint,uuid)'
  ] loop
    select pg_get_functiondef(signature::regprocedure) into definition;
    if (length(definition) - length(replace(definition, old_limit, ''))) / length(old_limit) <> 1 then
      raise exception 'Expected exactly one five-page limit in %', signature;
    end if;
    execute replace(definition, old_limit, new_limit);
  end loop;
end;
$$;
