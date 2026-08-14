-- RA-82: core receipt document, immutable extractions, append-only reviews, line costs.
-- Alters the RA-15 receipts stub. Does not add Housecall export tables (RA-83)
-- or status-transition guards (RA-84).
-- Store image keys and metadata only — never image binaries.

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.reject_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception '% is append-only', tg_table_name;
end;
$$;

create or replace function public.keep_receipt_owner()
returns trigger
language plpgsql
as $$
begin
  if new.owner_user_id is distinct from old.owner_user_id then
    raise exception 'owner_user_id is immutable';
  end if;
  return new;
end;
$$;

create or replace function public.receipt_visible_to_caller(p_receipt_id uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.receipts r
    where r.id = p_receipt_id
      and (
        r.owner_user_id = auth.uid()
        or public.current_user_role() in ('manager', 'admin')
      )
  )
$$;

alter table public.receipts
  add column status text not null default 'upload_pending',
  add column updated_at timestamptz not null default now(),
  add column submitted_at timestamptz,
  add column storage_key text,
  add column original_filename text,
  add column content_type text,
  add column checksum text,
  add column byte_size integer,
  add column gps_lat double precision,
  add column gps_lng double precision,
  add constraint receipts_status_check check (status in (
    'upload_pending',
    'submitted',
    'processing',
    'needs_review',
    'approved',
    'exporting',
    'exported',
    'partial_success',
    'rejected_unreadable',
    'rejected',
    'duplicate',
    'failed'
  )),
  add constraint receipts_byte_size_check check (byte_size is null or byte_size >= 0),
  add constraint receipts_gps_check check (
    (gps_lat is null and gps_lng is null)
    or (
      gps_lat is not null
      and gps_lng is not null
      and gps_lat >= -90
      and gps_lat <= 90
      and gps_lng >= -180
      and gps_lng <= 180
    )
  );

create index receipts_status_created_at_idx
  on public.receipts (status, created_at);

create index receipts_owner_created_at_idx
  on public.receipts (owner_user_id, created_at desc);

create trigger receipts_set_updated_at
  before update on public.receipts
  for each row execute function public.set_updated_at();

create trigger receipts_keep_owner
  before update on public.receipts
  for each row execute function public.keep_receipt_owner();

create table public.extractions (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references public.receipts (id) on delete cascade,
  schema_version integer not null default 1,
  provider text not null,
  vendor text,
  purchase_date text,
  invoice_number text,
  ticket_number text,
  receipt_total_cents integer,
  tax_cents integer,
  lines jsonb not null default '[]'::jsonb,
  confidence jsonb not null default '{}'::jsonb,
  raw_text text,
  created_at timestamptz not null default now(),
  constraint extractions_schema_version_check check (schema_version >= 1),
  constraint extractions_provider_check check (provider in (
    'gemini',
    'openai',
    'unknown'
  )),
  constraint extractions_receipt_total_cents_check
    check (receipt_total_cents is null or receipt_total_cents >= 0),
  constraint extractions_tax_cents_check
    check (tax_cents is null or tax_cents >= 0),
  constraint extractions_lines_array_check check (jsonb_typeof(lines) = 'array'),
  constraint extractions_confidence_object_check check (jsonb_typeof(confidence) = 'object')
);

create index extractions_receipt_id_created_at_idx
  on public.extractions (receipt_id, created_at desc);

create trigger extractions_append_only
  before update or delete on public.extractions
  for each row execute function public.reject_mutation();

create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references public.receipts (id) on delete cascade,
  actor_id uuid not null references auth.users (id),
  decision text not null,
  reason text,
  edits jsonb,
  canonical_receipt_id uuid references public.receipts (id),
  created_at timestamptz not null default now(),
  constraint reviews_decision_check check (decision in (
    'save_draft',
    'request_clarification',
    'decline',
    'mark_duplicate',
    'approve'
  ))
);

create index reviews_receipt_id_created_at_idx
  on public.reviews (receipt_id, created_at desc);

create trigger reviews_append_only
  before update or delete on public.reviews
  for each row execute function public.reject_mutation();

create table public.receipt_lines (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references public.receipts (id) on delete cascade,
  extraction_id uuid references public.extractions (id) on delete set null,
  sort_index integer not null,
  description text not null,
  qty numeric not null,
  uom text,
  unit_cost_cents integer not null,
  job_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint receipt_lines_unit_cost_cents_check check (unit_cost_cents >= 0),
  constraint receipt_lines_receipt_id_sort_index_key unique (receipt_id, sort_index)
);

create index receipt_lines_receipt_id_idx
  on public.receipt_lines (receipt_id);

create trigger receipt_lines_set_updated_at
  before update on public.receipt_lines
  for each row execute function public.set_updated_at();

alter table public.extractions enable row level security;
alter table public.reviews enable row level security;
alter table public.receipt_lines enable row level security;

create policy "receipts_insert_own"
  on public.receipts
  for insert
  to authenticated
  with check (owner_user_id = auth.uid());

create policy "receipts_update_owner_or_staff"
  on public.receipts
  for update
  to authenticated
  using (
    owner_user_id = auth.uid()
    or public.current_user_role() in ('manager', 'admin')
  )
  with check (
    owner_user_id = auth.uid()
    or public.current_user_role() in ('manager', 'admin')
  );

create policy "extractions_select_via_receipt"
  on public.extractions
  for select
  to authenticated
  using (public.receipt_visible_to_caller(receipt_id));

create policy "extractions_insert_via_receipt"
  on public.extractions
  for insert
  to authenticated
  with check (public.receipt_visible_to_caller(receipt_id));

create policy "reviews_select_via_receipt"
  on public.reviews
  for select
  to authenticated
  using (public.receipt_visible_to_caller(receipt_id));

create policy "reviews_insert_staff"
  on public.reviews
  for insert
  to authenticated
  with check (
    public.current_user_role() in ('manager', 'admin')
    and actor_id = auth.uid()
    and public.receipt_visible_to_caller(receipt_id)
  );

create policy "receipt_lines_select_via_receipt"
  on public.receipt_lines
  for select
  to authenticated
  using (public.receipt_visible_to_caller(receipt_id));

create policy "receipt_lines_insert_via_receipt"
  on public.receipt_lines
  for insert
  to authenticated
  with check (public.receipt_visible_to_caller(receipt_id));

create policy "receipt_lines_update_via_receipt"
  on public.receipt_lines
  for update
  to authenticated
  using (public.receipt_visible_to_caller(receipt_id))
  with check (public.receipt_visible_to_caller(receipt_id));
