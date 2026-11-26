-- SOBBLEKING：訂單 Email 通知欄位
alter table public.sk_orders
  add column if not exists customer_email text;

create index if not exists sk_orders_customer_email_idx
  on public.sk_orders(customer_email);
