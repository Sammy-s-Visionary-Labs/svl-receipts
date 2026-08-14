-- RA-83: Housecall job suggestions, approve intent snapshot, identity links,
-- and append-only export attempts. Does not add status-transition guards (RA-84).
-- Reuses public.reject_mutation and public.receipt_visible_to_caller from RA-82.

create table public.job_candidates (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references public.receipts (id) on delete cascade,
  receipt_line_id uuid references public.receipt_lines (id) on delete set null,
  housecall_job_id text not null,
  label text,
  source text,
  created_at timestamptz not null default now()
);

create index job_candidates_receipt_id_created_at_idx
  on public.job_candidates (receipt_id, created_at desc);

create index job_candidates_housecall_job_id_idx
  on public.job_candidates (housecall_job_id);

create trigger job_candidates_append_only
  before update or delete on public.job_candidates
  for each row execute function public.reject_mutation();

create table public.housecall_intents (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references public.receipts (id) on delete cascade,
  review_id uuid references public.reviews (id) on delete set null,
  payload_version integer not null default 1,
  attachment_job_ids jsonb not null default '[]'::jsonb,
  job_cost_lines jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  constraint housecall_intents_payload_version_check check (payload_version >= 1),
  constraint housecall_intents_attachment_job_ids_array_check
    check (jsonb_typeof(attachment_job_ids) = 'array'),
  constraint housecall_intents_job_cost_lines_array_check
    check (jsonb_typeof(job_cost_lines) = 'array')
);

create index housecall_intents_receipt_id_created_at_idx
  on public.housecall_intents (receipt_id, created_at desc);

create trigger housecall_intents_append_only
  before update or delete on public.housecall_intents
  for each row execute function public.reject_mutation();

create table public.housecall_links (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references public.receipts (id) on delete cascade,
  receipt_line_id uuid references public.receipt_lines (id) on delete set null,
  intent_id uuid references public.housecall_intents (id) on delete set null,
  housecall_job_id text not null,
  step text not null,
  payload_version integer not null default 1,
  external_id text not null,
  created_at timestamptz not null default now(),
  constraint housecall_links_payload_version_check check (payload_version >= 1),
  constraint housecall_links_step_check check (step in (
    'attachment',
    'job_cost'
  )),
  constraint housecall_links_step_line_check check (
    (step = 'attachment' and receipt_line_id is null)
    or (step = 'job_cost' and receipt_line_id is not null)
  )
);

create index housecall_links_receipt_id_idx
  on public.housecall_links (receipt_id);

create index housecall_links_housecall_job_id_idx
  on public.housecall_links (housecall_job_id);

create index housecall_links_receipt_line_id_idx
  on public.housecall_links (receipt_line_id);

create unique index housecall_links_attachment_uidx
  on public.housecall_links (receipt_id, housecall_job_id)
  where step = 'attachment';

create unique index housecall_links_job_cost_uidx
  on public.housecall_links (receipt_id, receipt_line_id, housecall_job_id)
  where step = 'job_cost';

create trigger housecall_links_append_only
  before update or delete on public.housecall_links
  for each row execute function public.reject_mutation();

create table public.export_attempts (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references public.receipts (id) on delete cascade,
  receipt_line_id uuid references public.receipt_lines (id) on delete set null,
  intent_id uuid references public.housecall_intents (id) on delete set null,
  housecall_job_id text not null,
  step text not null,
  status text not null,
  payload_version integer not null default 1,
  idempotency_key text not null,
  external_id text,
  error_code text,
  created_at timestamptz not null default now(),
  constraint export_attempts_payload_version_check check (payload_version >= 1),
  constraint export_attempts_step_check check (step in (
    'attachment',
    'job_cost'
  )),
  constraint export_attempts_status_check check (status in (
    'pending',
    'in_progress',
    'succeeded',
    'retryable_failure',
    'permanent_failure',
    'skipped'
  )),
  constraint export_attempts_step_line_check check (
    (step = 'attachment' and receipt_line_id is null)
    or (step = 'job_cost' and receipt_line_id is not null)
  )
);

create index export_attempts_status_created_at_idx
  on public.export_attempts (status, created_at);

create index export_attempts_receipt_id_created_at_idx
  on public.export_attempts (receipt_id, created_at desc);

create index export_attempts_housecall_job_id_idx
  on public.export_attempts (housecall_job_id);

create unique index export_attempts_idempotency_key_uidx
  on public.export_attempts (idempotency_key);

create trigger export_attempts_append_only
  before update or delete on public.export_attempts
  for each row execute function public.reject_mutation();

alter table public.job_candidates enable row level security;
alter table public.housecall_intents enable row level security;
alter table public.housecall_links enable row level security;
alter table public.export_attempts enable row level security;

create policy "job_candidates_select_via_receipt"
  on public.job_candidates
  for select
  to authenticated
  using (public.receipt_visible_to_caller(receipt_id));

create policy "job_candidates_insert_via_receipt"
  on public.job_candidates
  for insert
  to authenticated
  with check (public.receipt_visible_to_caller(receipt_id));

create policy "housecall_intents_select_via_receipt"
  on public.housecall_intents
  for select
  to authenticated
  using (public.receipt_visible_to_caller(receipt_id));

create policy "housecall_intents_insert_staff"
  on public.housecall_intents
  for insert
  to authenticated
  with check (
    public.current_user_role() in ('manager', 'admin')
    and public.receipt_visible_to_caller(receipt_id)
  );

create policy "housecall_links_select_via_receipt"
  on public.housecall_links
  for select
  to authenticated
  using (public.receipt_visible_to_caller(receipt_id));

create policy "housecall_links_insert_staff"
  on public.housecall_links
  for insert
  to authenticated
  with check (
    public.current_user_role() in ('manager', 'admin')
    and public.receipt_visible_to_caller(receipt_id)
  );

create policy "export_attempts_select_via_receipt"
  on public.export_attempts
  for select
  to authenticated
  using (public.receipt_visible_to_caller(receipt_id));

create policy "export_attempts_insert_staff"
  on public.export_attempts
  for insert
  to authenticated
  with check (
    public.current_user_role() in ('manager', 'admin')
    and public.receipt_visible_to_caller(receipt_id)
  );
