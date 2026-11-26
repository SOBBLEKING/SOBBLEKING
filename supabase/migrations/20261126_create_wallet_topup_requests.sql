-- SOBBLEKING：會員儲值申請（只建立待確認申請，不直接增加錢包餘額）
create table if not exists public.sk_wallet_topup_requests (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete restrict,
  amount integer not null check (amount >= 500 and amount % 500 = 0),
  payment_method text not null check (payment_method in ('無卡存款','銀行匯款','LINE Pay')),
  payment_bank text not null default '',
  status text not null default 'pending' check (status in ('pending','confirmed','rejected','cancelled')),
  client_request_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  confirmed_at timestamptz,
  admin_note text,
  unique (customer_id, client_request_id),
  constraint sk_wallet_topup_bank_check check (
    (payment_method = '無卡存款' and payment_bank in ('國泰世華（013）','台新銀行（812）','郵局（700）','中國信託（822）'))
    or (payment_method <> '無卡存款' and payment_bank = '')
  )
);

create index if not exists sk_wallet_topup_customer_created_idx
  on public.sk_wallet_topup_requests(customer_id, created_at desc);

alter table public.sk_wallet_topup_requests enable row level security;

drop policy if exists sk_wallet_topup_service_role_only on public.sk_wallet_topup_requests;
create policy sk_wallet_topup_service_role_only
  on public.sk_wallet_topup_requests
  for all to service_role
  using (true) with check (true);

revoke all on public.sk_wallet_topup_requests from anon, authenticated;
grant all on public.sk_wallet_topup_requests to service_role;
