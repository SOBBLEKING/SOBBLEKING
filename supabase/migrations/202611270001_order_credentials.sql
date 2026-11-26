-- Secure, per-order game credentials. Secrets are encrypted by the Edge Function before storage.
create table if not exists public.sk_order_credentials (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.sk_orders(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  encrypted_payload text not null,
  iv text not null,
  submitted_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sk_order_credentials_customer_id_idx
  on public.sk_order_credentials(customer_id);

alter table public.sk_order_credentials enable row level security;
revoke all on public.sk_order_credentials from anon, authenticated;
grant all on public.sk_order_credentials to service_role;

create table if not exists public.sk_order_credential_access_logs (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.sk_orders(id) on delete cascade,
  admin_email text not null,
  accessed_at timestamptz not null default now()
);

create index if not exists sk_order_credential_access_logs_order_id_idx
  on public.sk_order_credential_access_logs(order_id);

alter table public.sk_order_credential_access_logs enable row level security;
revoke all on public.sk_order_credential_access_logs from anon, authenticated;
grant all on public.sk_order_credential_access_logs to service_role;
