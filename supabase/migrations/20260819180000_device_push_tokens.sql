-- RA-20 / RA-210: store Expo push tokens server-side so RA-25 can send Needs retake.
-- Mutations go through Next.js + service_role only. Workers do not write this table
-- through the Data API.

create table public.device_push_tokens (
  user_id uuid primary key references auth.users (id) on delete cascade,
  expo_push_token text not null,
  platform text not null,
  updated_at timestamptz not null default now(),
  constraint device_push_tokens_platform_check check (platform in ('ios', 'android', 'web')),
  constraint device_push_tokens_token_length_check check (
    char_length(expo_push_token) >= 20
    and char_length(expo_push_token) <= 512
  )
);

create unique index device_push_tokens_expo_push_token_uidx
  on public.device_push_tokens (expo_push_token);

alter table public.device_push_tokens enable row level security;

revoke all on table public.device_push_tokens from public, anon, authenticated;
grant all on table public.device_push_tokens to service_role;

create or replace function public.upsert_device_push_token(
  p_user_id uuid,
  p_token text,
  p_platform text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  token text;
begin
  perform public.require_active_actor(p_user_id, array['worker']);

  token := trim(p_token);
  if token is null or char_length(token) < 20 or char_length(token) > 512 then
    raise exception 'invalid_request';
  end if;
  if p_platform is null or p_platform not in ('ios', 'android', 'web') then
    raise exception 'invalid_request';
  end if;

  delete from public.device_push_tokens
  where expo_push_token = token
    and user_id <> p_user_id;

  insert into public.device_push_tokens (user_id, expo_push_token, platform)
  values (p_user_id, token, p_platform)
  on conflict (user_id) do update
  set
    expo_push_token = excluded.expo_push_token,
    platform = excluded.platform,
    updated_at = now();
end;
$$;

revoke all on function public.upsert_device_push_token(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.upsert_device_push_token(uuid, text, text) to service_role;
