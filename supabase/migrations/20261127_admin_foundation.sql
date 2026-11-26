-- SOBBLEKING Admin Foundation v1
-- Safe additive migration. Does not delete existing customer/order data.

create table if not exists public.sk_wallet_accounts (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null unique references public.customers(id) on delete restrict,
  balance numeric(12,2) not null default 0 check (balance >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sk_wallet_transactions (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null references public.sk_wallet_accounts(id) on delete restrict,
  customer_id uuid not null references public.customers(id) on delete restrict,
  transaction_type text not null check (transaction_type in ('topup','topup_bonus','purchase','refund','manual_credit','manual_debit','adjustment')),
  amount numeric(12,2) not null check (amount <> 0),
  balance_before numeric(12,2) not null check (balance_before >= 0),
  balance_after numeric(12,2) not null check (balance_after >= 0),
  reference_id uuid,
  description text not null default '',
  admin_email text,
  created_at timestamptz not null default now()
);
create index if not exists sk_wallet_transactions_customer_created_idx
  on public.sk_wallet_transactions(customer_id, created_at desc);
create unique index if not exists sk_wallet_transactions_topup_once_idx
  on public.sk_wallet_transactions(reference_id, transaction_type)
  where reference_id is not null and transaction_type in ('topup','topup_bonus');

create table if not exists public.sk_admin_audit_logs (
  id uuid primary key default gen_random_uuid(),
  admin_email text not null,
  action text not null,
  target_type text not null,
  target_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists sk_admin_audit_created_idx
  on public.sk_admin_audit_logs(created_at desc);

create table if not exists public.sk_topup_campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  min_amount integer not null check (min_amount >= 500 and min_amount % 500 = 0),
  bonus_amount integer not null default 0 check (bonus_amount >= 0),
  starts_at timestamptz,
  ends_at timestamptz,
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at is null or starts_at is null or ends_at > starts_at)
);

create table if not exists public.sk_coupons (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  title text not null,
  discount_type text not null check (discount_type in ('fixed','percent')),
  discount_value numeric(12,2) not null check (discount_value > 0),
  total_limit integer check (total_limit is null or total_limit > 0),
  per_customer_limit integer not null default 1 check (per_customer_limit > 0),
  starts_at timestamptz,
  ends_at timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (discount_type <> 'percent' or discount_value <= 100),
  check (ends_at is null or starts_at is null or ends_at > starts_at)
);
create table if not exists public.sk_coupon_redemptions (
  id uuid primary key default gen_random_uuid(),
  coupon_id uuid not null references public.sk_coupons(id) on delete restrict,
  customer_id uuid not null references public.customers(id) on delete restrict,
  order_id uuid references public.sk_orders(id) on delete restrict,
  discount_amount numeric(12,2) not null check (discount_amount >= 0),
  created_at timestamptz not null default now()
);
create index if not exists sk_coupon_redemptions_coupon_idx
  on public.sk_coupon_redemptions(coupon_id, customer_id);

create table if not exists public.sk_admin_settings (
  setting_key text primary key,
  setting_value jsonb not null default '{}'::jsonb,
  updated_by text,
  updated_at timestamptz not null default now()
);

alter table public.sk_wallet_accounts enable row level security;
alter table public.sk_wallet_transactions enable row level security;
alter table public.sk_admin_audit_logs enable row level security;
alter table public.sk_topup_campaigns enable row level security;
alter table public.sk_coupons enable row level security;
alter table public.sk_coupon_redemptions enable row level security;
alter table public.sk_admin_settings enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'sk_wallet_accounts','sk_wallet_transactions','sk_admin_audit_logs',
    'sk_topup_campaigns','sk_coupons','sk_coupon_redemptions','sk_admin_settings'
  ] loop
    execute format('drop policy if exists %I on public.%I', t || '_service_role_only', t);
    execute format(
      'create policy %I on public.%I for all to service_role using (true) with check (true)',
      t || '_service_role_only', t
    );
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;
