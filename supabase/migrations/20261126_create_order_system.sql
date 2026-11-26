-- SOBBLEKING：獨立訂單系統（不覆蓋既有 orders / order_items）
-- 執行方式：Supabase SQL Editor 整份貼上並 Run。
-- 此版本只允許 Edge Function 使用 service_role 呼叫建立訂單函式。

create table if not exists public.sk_orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique,
  customer_id uuid not null,
  total_amount numeric(12,2) not null check (total_amount >= 0),
  payment_status text not null default 'unpaid'
    check (payment_status in ('unpaid','paid','refunded','failed')),
  order_status text not null default 'pending'
    check (order_status in ('pending','processing','completed','cancelled')),
  payment_method text,
  note text,
  client_request_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  paid_at timestamptz,
  unique (customer_id, client_request_id)
);

create table if not exists public.sk_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.sk_orders(id) on delete cascade,
  product_id uuid not null,
  product_name text not null,
  unit_price numeric(12,2) not null check (unit_price >= 0),
  quantity integer not null check (quantity > 0),
  subtotal numeric(12,2) not null check (subtotal >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.sk_order_verification_codes (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.sk_orders(id) on delete cascade,
  verification_code text not null unique,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists sk_orders_customer_created_idx
  on public.sk_orders(customer_id, created_at desc);
create index if not exists sk_order_items_order_idx
  on public.sk_order_items(order_id);

alter table public.sk_orders enable row level security;
alter table public.sk_order_items enable row level security;
alter table public.sk_order_verification_codes enable row level security;

create policy sk_orders_service_role_only on public.sk_orders
  for all to service_role using (true) with check (true);
create policy sk_order_items_service_role_only on public.sk_order_items
  for all to service_role using (true) with check (true);
create policy sk_order_codes_service_role_only on public.sk_order_verification_codes
  for all to service_role using (true) with check (true);

create or replace function public.sk_create_order(
  p_customer_id uuid,
  p_items jsonb,
  p_note text default null,
  p_client_request_id uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_product record;
  v_order_id uuid;
  v_order_number text;
  v_code text;
  v_total numeric(12,2) := 0;
  v_qty integer;
  v_existing public.sk_orders%rowtype;
  v_chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  i integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'not_authorized';
  end if;
  if p_customer_id is null then
    raise exception 'customer_id_required';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'items_required';
  end if;

  select * into v_existing
  from public.sk_orders
  where customer_id = p_customer_id
    and client_request_id = p_client_request_id;
  if found then
    return jsonb_build_object(
      'success', true,
      'order_id', v_existing.id,
      'order_number', v_existing.order_number,
      'total_amount', v_existing.total_amount,
      'reused', true
    );
  end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    if (v_item->>'quantity') is null
       or (v_item->>'quantity') !~ '^[0-9]+$' then
      raise exception 'invalid_quantity';
    end if;
    v_qty := (v_item->>'quantity')::integer;
    if v_qty < 1 or v_qty > 99 then
      raise exception 'invalid_quantity';
    end if;

    select id, name, price
      into v_product
    from public.products
    where id = (v_item->>'product_id')::uuid
      and is_active = true
    for share;

    if not found then
      raise exception 'product_unavailable';
    end if;
    if v_product.price is null or v_product.price < 0 then
      raise exception 'invalid_product_price';
    end if;
    v_total := v_total + (v_product.price * v_qty);
  end loop;

  loop
    v_order_number := 'SKD-';
    for i in 1..8 loop
      v_order_number := v_order_number || substr(v_chars, floor(random()*length(v_chars))::integer + 1, 1);
    end loop;
    exit when not exists (
      select 1 from public.sk_orders where order_number = v_order_number
    );
  end loop;

  insert into public.sk_orders (
    order_number, customer_id, total_amount, note, client_request_id
  ) values (
    v_order_number, p_customer_id, v_total, nullif(left(coalesce(p_note,''),1000),''),
    p_client_request_id
  )
  returning id into v_order_id;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_qty := (v_item->>'quantity')::integer;
    select id, name, price into v_product
    from public.products
    where id = (v_item->>'product_id')::uuid
      and is_active = true
    for share;

    insert into public.sk_order_items (
      order_id, product_id, product_name, unit_price, quantity, subtotal
    ) values (
      v_order_id, v_product.id, v_product.name, v_product.price,
      v_qty, v_product.price * v_qty
    );
  end loop;

  loop
    v_code := '';
    for i in 1..8 loop
      v_code := v_code || substr(v_chars, floor(random()*length(v_chars))::integer + 1, 1);
    end loop;
    exit when not exists (
      select 1 from public.sk_order_verification_codes
      where verification_code = v_code
    );
  end loop;

  insert into public.sk_order_verification_codes(order_id, verification_code)
  values (v_order_id, v_code);

  return jsonb_build_object(
    'success', true,
    'order_id', v_order_id,
    'order_number', v_order_number,
    'total_amount', v_total,
    'verification_code', v_code,
    'reused', false
  );
end;
$$;

revoke all on function public.sk_create_order(uuid,jsonb,text,uuid) from public, anon, authenticated;
grant execute on function public.sk_create_order(uuid,jsonb,text,uuid) to service_role;
