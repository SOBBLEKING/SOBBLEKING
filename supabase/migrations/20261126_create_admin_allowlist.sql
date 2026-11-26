-- SOBBLEKING 管理員信箱白名單
create table if not exists public.sk_admin_emails (
  email text primary key,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.sk_admin_emails (email, is_active)
values ('sobblekinggg@gmail.com', true)
on conflict (email) do update set is_active = excluded.is_active;

alter table public.sk_admin_emails enable row level security;

drop policy if exists sk_admin_emails_read_own on public.sk_admin_emails;
create policy sk_admin_emails_read_own
  on public.sk_admin_emails
  for select
  to authenticated
  using (
    is_active = true
    and lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );

revoke all on public.sk_admin_emails from anon, authenticated;
grant select on public.sk_admin_emails to authenticated;
