-- RA-79 / RA-81: server-verifiable roles and a thin receipt row for ownership checks.
-- RA-16 will expand `receipts` into the full lifecycle schema.
-- Never trust a client-supplied role field.

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('worker', 'manager', 'admin')),
  disabled boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.receipts (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create index receipts_owner_user_id_idx on public.receipts (owner_user_id);

-- Avoid RLS recursion when policies need the caller's role.
create or replace function public.current_user_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role
  from public.profiles
  where id = auth.uid()
    and disabled = false
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, role, disabled)
  values (new.id, 'worker', false)
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.receipts enable row level security;

create policy "profiles_select_self_or_staff"
  on public.profiles
  for select
  to authenticated
  using (
    id = auth.uid()
    or public.current_user_role() in ('manager', 'admin')
  );

-- Role and disabled are changed by a dashboard admin / service role, not by the client.
create policy "receipts_select_owner_or_staff"
  on public.receipts
  for select
  to authenticated
  using (
    owner_user_id = auth.uid()
    or public.current_user_role() in ('manager', 'admin')
  );
