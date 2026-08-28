-- RA-23 applied-schema and transactional confirmation checks.
-- Safe against populated databases: every mutation is rolled back.

begin;

do $$
declare
  byte_size_constraint text;
begin
  if not exists (
    select 1 from pg_tables
    where schemaname = 'public' and tablename = 'receipt_pages' and rowsecurity
  ) then
    raise exception 'receipt_pages must exist with RLS enabled';
  end if;

  if has_table_privilege('anon', 'public.receipt_pages', 'SELECT,INSERT,UPDATE,DELETE')
    or has_table_privilege('authenticated', 'public.receipt_pages', 'INSERT,UPDATE,DELETE') then
    raise exception 'receipt_pages client privileges are too broad';
  end if;
  if not has_table_privilege('authenticated', 'public.receipt_pages', 'SELECT') then
    raise exception 'authenticated must be able to select visible receipt pages';
  end if;

  if has_function_privilege(
      'authenticated',
      'create_upload_pending_receipt_set(uuid,uuid,jsonb,double precision,double precision,double precision,timestamptz,uuid)',
      'EXECUTE'
    )
    or has_function_privilege(
      'authenticated',
      'submit_confirmed_receipt_set(uuid,uuid,jsonb,text,bigint,uuid)',
      'EXECUTE'
    ) then
    raise exception 'RA-23 mutation RPCs must not be client executable';
  end if;
  if not has_function_privilege(
      'service_role',
      'create_upload_pending_receipt_set(uuid,uuid,jsonb,double precision,double precision,double precision,timestamptz,uuid)',
      'EXECUTE'
    )
    or not has_function_privilege(
      'service_role',
      'submit_confirmed_receipt_set(uuid,uuid,jsonb,text,bigint,uuid)',
      'EXECUTE'
    ) then
    raise exception 'service_role must execute RA-23 mutation RPCs';
  end if;

  select pg_get_constraintdef(oid)
  into byte_size_constraint
  from pg_constraint
  where conrelid = 'public.receipt_pages'::regclass
    and conname = 'receipt_pages_byte_size_check';

  if byte_size_constraint is null
    or position('byte_size <= 10485760' in byte_size_constraint) = 0 then
    raise exception 'receipt_pages must enforce the 10 MiB per-page limit';
  end if;
end;
$$;

do $$
declare
  owner uuid;
  receipt uuid := gen_random_uuid();
  first_checksum text := repeat('a', 64);
  second_checksum text := repeat('b', 64);
  manifest_checksum text := repeat('c', 64);
  submitted jsonb;
  conflict_seen boolean := false;
  oversize_seen boolean := false;
  purge_work uuid;
begin
  insert into auth.users (
    instance_id,
    id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    created_at,
    updated_at,
    raw_app_meta_data,
    raw_user_meta_data,
    is_super_admin,
    is_sso_user,
    is_anonymous
  ) values (
    '00000000-0000-0000-0000-000000000000',
    gen_random_uuid(),
    'authenticated',
    'authenticated',
    'ra23-' || replace(gen_random_uuid()::text, '-', '') || '@example.invalid',
    extensions.crypt('applied-test', extensions.gen_salt('bf')),
    now(),
    now(),
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    false,
    false,
    false
  )
  returning id into owner;

  perform public.create_upload_pending_receipt_set(
    owner,
    receipt,
    jsonb_build_array(
      jsonb_build_object(
        'pageIndex', 0,
        'storageKey', owner || '/' || receipt || '/page-0.jpg',
        'contentType', 'image/jpeg',
        'originalFilename', 'first.jpg'
      ),
      jsonb_build_object(
        'pageIndex', 1,
        'storageKey', owner || '/' || receipt || '/page-1.jpg',
        'contentType', 'image/jpeg',
        'originalFilename', 'second.jpg'
      )
    ),
    39.9612,
    -82.9988,
    15,
    now(),
    gen_random_uuid()
  );

  if (select count(*) from public.receipt_pages where receipt_id = receipt) is distinct from 2 then
    raise exception 'create_upload_pending_receipt_set did not persist both pages';
  end if;
  if not exists (
    select 1 from public.receipts
    where id = receipt
      and status = 'upload_pending'
      and gps_accuracy_meters = 15
      and gps_captured_at is not null
  ) then
    raise exception 'receipt session metadata was not persisted';
  end if;

  submitted := public.submit_confirmed_receipt_set(
    receipt,
    owner,
    jsonb_build_array(
      jsonb_build_object('pageIndex', 0, 'checksum', first_checksum, 'byteSize', 100),
      jsonb_build_object('pageIndex', 1, 'checksum', second_checksum, 'byteSize', 200)
    ),
    manifest_checksum,
    300,
    gen_random_uuid()
  );

  if submitted->>'status' is distinct from 'submitted'
    or submitted->>'submittedAt' is null
    or exists (
      select 1 from public.receipt_pages
      where receipt_id = receipt
        and (checksum is null or byte_size is null or confirmed_at is null)
    )
    or not exists (
      select 1 from public.receipts
      where id = receipt
        and status = 'submitted'
        and checksum = manifest_checksum
        and byte_size = 300
    ) then
    raise exception 'full page confirmation was not atomic and durable';
  end if;

  -- The same confirmation is idempotent.
  perform public.submit_confirmed_receipt_set(
    receipt,
    owner,
    jsonb_build_array(
      jsonb_build_object('pageIndex', 0, 'checksum', first_checksum, 'byteSize', 100),
      jsonb_build_object('pageIndex', 1, 'checksum', second_checksum, 'byteSize', 200)
    ),
    manifest_checksum,
    300,
    gen_random_uuid()
  );

  begin
    perform public.submit_confirmed_receipt_set(
      receipt,
      owner,
      jsonb_build_array(
        jsonb_build_object('pageIndex', 0, 'checksum', first_checksum, 'byteSize', 100)
      ),
      manifest_checksum,
      100,
      gen_random_uuid()
    );
  exception when others then
    conflict_seen := true;
  end;
  if not conflict_seen then
    raise exception 'partial page confirmation must fail';
  end if;

  begin
    update public.receipt_pages
    set byte_size = 10485761
    where receipt_id = receipt
      and page_index = 0;
  exception when check_violation then
    oversize_seen := true;
  end;
  if not oversize_seen then
    raise exception 'receipt_pages must reject page metadata over 10 MiB';
  end if;

  -- A location-bearing receipt must clear all four location fields during the
  -- fenced retention purge. This also proves the receipt_pages cleanup trigger
  -- runs in the same transaction.
  update public.receipts
  set
    retention_started_at = now() - interval '366 days',
    delete_after_at = now() - interval '1 day'
  where id = receipt;

  insert into public.work_items (
    receipt_id,
    kind,
    status,
    attempt_count,
    next_attempt_at,
    lease_owner,
    lease_expires_at
  ) values (
    receipt,
    'purge',
    'leased',
    1,
    now(),
    'ra23-gps-purge',
    now() + interval '5 minutes'
  )
  returning id into purge_work;

  perform public.assert_purge_eligible(receipt, 'ra23-gps-purge');
  perform public.purge_receipt_content(receipt, 'ra23-gps-purge');

  if exists (
    select 1
    from public.receipts
    where id = receipt
      and (
        content_deleted_at is null
        or gps_lat is not null
        or gps_lng is not null
        or gps_accuracy_meters is not null
        or gps_captured_at is not null
      )
  ) or exists (
    select 1 from public.receipt_pages where receipt_id = receipt
  ) then
    raise exception 'location purge must clear all location fields and the page manifest';
  end if;
end;
$$;

rollback;
