-- RA-23: persist 1..N immutable upload targets per receipt and only submit
-- after the complete page manifest has been verified by the API.

alter table public.receipts
  add column gps_accuracy_meters double precision,
  add column gps_captured_at timestamptz,
  add constraint receipts_gps_accuracy_check check (
    gps_accuracy_meters is null
    or (
      gps_lat is not null
      and gps_lng is not null
      and gps_accuracy_meters >= 0
    )
  ),
  add constraint receipts_gps_captured_at_check check (
    gps_captured_at is null
    or (gps_lat is not null and gps_lng is not null)
  );

create table public.receipt_pages (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references public.receipts (id) on delete cascade,
  page_index smallint not null,
  storage_key text not null,
  original_filename text,
  content_type text not null,
  checksum text,
  byte_size integer,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint receipt_pages_receipt_page_unique unique (receipt_id, page_index),
  constraint receipt_pages_storage_key_unique unique (storage_key),
  constraint receipt_pages_page_index_check check (page_index >= 0 and page_index < 5),
  constraint receipt_pages_storage_key_check check (length(trim(storage_key)) > 0),
  constraint receipt_pages_content_type_check check (
    content_type in ('image/jpeg', 'image/png', 'image/webp')
  ),
  constraint receipt_pages_checksum_check check (
    checksum is null or checksum ~ '^[a-f0-9]{64}$'
  ),
  constraint receipt_pages_byte_size_check check (
    byte_size is null or (byte_size > 0 and byte_size <= 10485760)
  ),
  constraint receipt_pages_confirmation_check check (
    (checksum is null and byte_size is null and confirmed_at is null)
    or (checksum is not null and byte_size is not null and confirmed_at is not null)
  )
);

alter table public.receipt_pages enable row level security;

create policy "receipt_pages_select_via_receipt"
  on public.receipt_pages
  for select
  to authenticated
  using ((select public.receipt_visible_to_caller(receipt_id)));

revoke all on table public.receipt_pages from public, anon, authenticated;
grant select on table public.receipt_pages to authenticated, service_role;

-- Preserve existing single-page receipts while making receipt_pages authoritative
-- for every new upload session.
insert into public.receipt_pages (
  receipt_id,
  page_index,
  storage_key,
  original_filename,
  content_type,
  checksum,
  byte_size,
  confirmed_at
)
select
  r.id,
  0,
  r.storage_key,
  r.original_filename,
  r.content_type,
  case
    when r.checksum ~ '^[a-f0-9]{64}$'
      and r.content_type in ('image/jpeg', 'image/png', 'image/webp')
      and r.byte_size > 0
      and r.byte_size <= 10485760
      then r.checksum
    else null
  end,
  case
    when r.checksum ~ '^[a-f0-9]{64}$'
      and r.content_type in ('image/jpeg', 'image/png', 'image/webp')
      and r.byte_size > 0
      and r.byte_size <= 10485760
      then r.byte_size
    else null
  end,
  case
    when r.checksum ~ '^[a-f0-9]{64}$'
      and r.content_type in ('image/jpeg', 'image/png', 'image/webp')
      and r.byte_size > 0
      and r.byte_size <= 10485760
      then coalesce(r.submitted_at, r.updated_at)
    else null
  end
from public.receipts r
where r.storage_key is not null
  and r.content_type in ('image/jpeg', 'image/png', 'image/webp')
on conflict (receipt_id, page_index) do nothing;

create or replace function public.create_upload_pending_receipt_set(
  p_actor_id uuid,
  p_receipt_id uuid,
  p_pages jsonb,
  p_gps_lat double precision default null,
  p_gps_lng double precision default null,
  p_gps_accuracy_meters double precision default null,
  p_gps_captured_at timestamptz default null,
  p_correlation_id uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  rec public.receipts%rowtype;
  page jsonb;
  page_count integer;
  stored_count integer;
  first_page jsonb;
begin
  perform public.require_active_actor(p_actor_id, null);

  if p_receipt_id is null
    or jsonb_typeof(p_pages) is distinct from 'array'
    or jsonb_array_length(p_pages) < 1
    or jsonb_array_length(p_pages) > 5 then
    raise exception 'invalid_request';
  end if;

  if (p_gps_lat is null) is distinct from (p_gps_lng is null)
    or p_gps_lat < -90 or p_gps_lat > 90
    or p_gps_lng < -180 or p_gps_lng > 180
    or p_gps_accuracy_meters < 0
    or (p_gps_lat is not null and p_gps_captured_at is null)
    or (
      p_gps_lat is null
      and (p_gps_accuracy_meters is not null or p_gps_captured_at is not null)
    ) then
    raise exception 'invalid_request';
  end if;

  page_count := jsonb_array_length(p_pages);
  for page in
    select value from jsonb_array_elements(p_pages)
  loop
    if jsonb_typeof(page) is distinct from 'object'
      or (page->>'pageIndex') is null
      or (page->>'pageIndex')::integer < 0
      or (page->>'pageIndex')::integer >= page_count
      or nullif(trim(page->>'storageKey'), '') is null
      or (page->>'contentType') not in ('image/jpeg', 'image/png', 'image/webp') then
      raise exception 'invalid_request';
    end if;
  end loop;

  if (
    select count(distinct (value->>'pageIndex')::integer)
    from jsonb_array_elements(p_pages)
  ) is distinct from page_count then
    raise exception 'invalid_request';
  end if;

  first_page := p_pages->0;
  perform set_config('svl.correlation_id', p_correlation_id::text, true);
  perform set_config('svl.actor_id', p_actor_id::text, true);

  insert into public.receipts (
    id,
    owner_user_id,
    status,
    storage_key,
    content_type,
    original_filename,
    gps_lat,
    gps_lng,
    gps_accuracy_meters,
    gps_captured_at
  ) values (
    p_receipt_id,
    p_actor_id,
    'upload_pending',
    first_page->>'storageKey',
    first_page->>'contentType',
    nullif(first_page->>'originalFilename', ''),
    p_gps_lat,
    p_gps_lng,
    p_gps_accuracy_meters,
    p_gps_captured_at
  )
  on conflict (id) do nothing;

  select * into rec
  from public.receipts
  where id = p_receipt_id
  for update;

  if not found
    or rec.owner_user_id is distinct from p_actor_id
    or rec.status is distinct from 'upload_pending'
    or rec.cleanup_claimed_at is not null then
    raise exception 'conflict';
  end if;

  for page in
    select value from jsonb_array_elements(p_pages)
  loop
    insert into public.receipt_pages (
      receipt_id,
      page_index,
      storage_key,
      original_filename,
      content_type
    ) values (
      p_receipt_id,
      (page->>'pageIndex')::smallint,
      page->>'storageKey',
      nullif(page->>'originalFilename', ''),
      page->>'contentType'
    )
    on conflict (receipt_id, page_index) do nothing;
  end loop;

  select count(*) into stored_count
  from public.receipt_pages rp
  where rp.receipt_id = p_receipt_id;

  if stored_count is distinct from page_count
    or exists (
      select 1
      from public.receipt_pages rp
      where rp.receipt_id = p_receipt_id
        and not exists (
          select 1
          from jsonb_array_elements(p_pages) supplied
          where (supplied->>'pageIndex')::smallint = rp.page_index
            and supplied->>'contentType' = rp.content_type
        )
    ) then
    raise exception 'conflict';
  end if;

  return jsonb_build_object(
    'id', rec.id,
    'status', rec.status,
    'pageCount', page_count
  );
end;
$$;

create or replace function public.submit_confirmed_receipt_set(
  p_receipt_id uuid,
  p_actor_id uuid,
  p_pages jsonb,
  p_manifest_checksum text,
  p_total_byte_size bigint,
  p_correlation_id uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  rec public.receipts%rowtype;
  page jsonb;
  expected_count integer;
  supplied_count integer;
begin
  perform public.require_active_actor(p_actor_id, null);

  if jsonb_typeof(p_pages) is distinct from 'array'
    or jsonb_array_length(p_pages) < 1
    or jsonb_array_length(p_pages) > 5
    or p_manifest_checksum !~ '^[a-f0-9]{64}$'
    or p_total_byte_size < 1
    or p_total_byte_size > 52428800 then
    raise exception 'invalid_request';
  end if;

  supplied_count := jsonb_array_length(p_pages);
  for page in
    select value from jsonb_array_elements(p_pages)
  loop
    if jsonb_typeof(page) is distinct from 'object'
      or (page->>'pageIndex') is null
      or (page->>'checksum') !~ '^[a-f0-9]{64}$'
      or (page->>'byteSize')::integer < 1
      or (page->>'byteSize')::integer > 10485760 then
      raise exception 'invalid_request';
    end if;
  end loop;

  if (
    select count(distinct (value->>'pageIndex')::integer)
    from jsonb_array_elements(p_pages)
  ) is distinct from supplied_count then
    raise exception 'invalid_request';
  end if;

  perform set_config('svl.correlation_id', p_correlation_id::text, true);
  perform set_config('svl.actor_id', p_actor_id::text, true);

  select * into rec
  from public.receipts
  where id = p_receipt_id
  for update;

  if not found or rec.owner_user_id is distinct from p_actor_id then
    raise exception 'forbidden';
  end if;

  select count(*) into expected_count
  from public.receipt_pages rp
  where rp.receipt_id = p_receipt_id;

  if expected_count is distinct from supplied_count then
    raise exception 'conflict';
  end if;

  if rec.status = 'submitted' then
    if rec.checksum is distinct from p_manifest_checksum
      or rec.byte_size is distinct from p_total_byte_size
      or exists (
        select 1
        from public.receipt_pages rp
        where rp.receipt_id = p_receipt_id
          and not exists (
            select 1
            from jsonb_array_elements(p_pages) supplied
            where (supplied->>'pageIndex')::smallint = rp.page_index
              and supplied->>'checksum' = rp.checksum
              and (supplied->>'byteSize')::integer = rp.byte_size
          )
      ) then
      raise exception 'conflict';
    end if;

    return jsonb_build_object(
      'id', rec.id,
      'status', rec.status,
      'submittedAt', rec.submitted_at
    );
  end if;

  if rec.status is distinct from 'upload_pending' or rec.cleanup_claimed_at is not null then
    raise exception 'conflict';
  end if;

  for page in
    select value from jsonb_array_elements(p_pages)
  loop
    update public.receipt_pages
    set
      checksum = page->>'checksum',
      byte_size = (page->>'byteSize')::integer,
      confirmed_at = now()
    where receipt_id = p_receipt_id
      and page_index = (page->>'pageIndex')::smallint;

    if not found then
      raise exception 'conflict';
    end if;
  end loop;

  update public.receipts
  set
    status = 'submitted',
    checksum = p_manifest_checksum,
    byte_size = p_total_byte_size,
    submitted_at = now()
  where id = p_receipt_id
    and status = 'upload_pending'
    and cleanup_claimed_at is null
  returning * into rec;

  if not found then
    raise exception 'conflict';
  end if;

  return jsonb_build_object(
    'id', rec.id,
    'status', rec.status,
    'submittedAt', rec.submitted_at
  );
end;
$$;

-- Page rows contain only object pointers and verification metadata. Remove them
-- in the same transaction that records a completed retention purge.
create or replace function public.delete_receipt_pages_after_purge()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.content_deleted_at is not null and old.content_deleted_at is null then
    delete from public.receipt_pages where receipt_id = new.id;
  end if;
  return new;
end;
$$;

create trigger receipts_delete_pages_after_purge
  after update of content_deleted_at on public.receipts
  for each row execute function public.delete_receipt_pages_after_purge();

-- RA-23 adds two location fields that must be cleared atomically with the
-- existing coordinates. Re-state the latest fenced purge implementation so a
-- location-bearing receipt cannot fail its CHECK constraints after Storage has
-- already been removed.
create or replace function public.purge_receipt_content(
  p_receipt_id uuid,
  p_worker_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  rec public.receipts%rowtype;
  work_row public.work_items%rowtype;
begin
  select * into work_row
  from public.work_items
  where receipt_id = p_receipt_id
    and kind = 'purge'
  for update;

  if not found
    or work_row.status is distinct from 'leased'
    or work_row.lease_owner is distinct from p_worker_id then
    raise exception 'conflict';
  end if;

  select * into rec
  from public.receipts
  where id = p_receipt_id
  for update;

  if not found then
    raise exception 'conflict';
  end if;

  if rec.content_deleted_at is not null then
    return jsonb_build_object('id', rec.id, 'contentDeletedAt', rec.content_deleted_at);
  end if;

  if rec.purge_claimed_at is null
    or rec.purge_claimed_by is distinct from p_worker_id then
    raise exception 'conflict';
  end if;

  if rec.retention_hold or rec.delete_after_at is null or rec.delete_after_at > now() then
    raise exception 'conflict';
  end if;

  perform set_config('svl.allow_purge', 'true', true);

  delete from public.job_candidates where receipt_id = p_receipt_id;
  delete from public.receipt_lines where receipt_id = p_receipt_id;
  delete from public.reviews where receipt_id = p_receipt_id;
  delete from public.extractions where receipt_id = p_receipt_id;

  update public.receipts
  set
    storage_key = null,
    original_filename = null,
    checksum = null,
    byte_size = null,
    content_type = null,
    gps_lat = null,
    gps_lng = null,
    gps_accuracy_meters = null,
    gps_captured_at = null,
    content_deleted_at = now(),
    purge_claimed_at = null,
    purge_claimed_by = null
  where id = p_receipt_id
  returning * into rec;

  perform public.append_audit_event(
    rec.id,
    'content_purged',
    jsonb_build_object('content_deleted', false),
    jsonb_build_object('content_deleted', true),
    jsonb_build_object('worker_id', p_worker_id),
    'worker',
    null
  );

  return jsonb_build_object('id', rec.id, 'contentDeletedAt', rec.content_deleted_at);
end;
$$;

revoke all on function public.create_upload_pending_receipt_set(
  uuid, uuid, jsonb, double precision, double precision, double precision, timestamptz, uuid
) from public, anon, authenticated;
revoke all on function public.submit_confirmed_receipt_set(
  uuid, uuid, jsonb, text, bigint, uuid
) from public, anon, authenticated;
revoke all on function public.delete_receipt_pages_after_purge()
  from public, anon, authenticated;
revoke all on function public.purge_receipt_content(uuid, text)
  from public, anon, authenticated;

grant execute on function public.create_upload_pending_receipt_set(
  uuid, uuid, jsonb, double precision, double precision, double precision, timestamptz, uuid
) to service_role;
grant execute on function public.submit_confirmed_receipt_set(
  uuid, uuid, jsonb, text, bigint, uuid
) to service_role;
grant execute on function public.purge_receipt_content(uuid, text)
  to service_role;
