-- SOBBLEKING：將付款方式與無卡存款銀行獨立保存
-- 安全性：建立訂單函式仍只允許 service_role 呼叫。
alter table public.sk_orders
  add column if not exists payment_bank text;

create or replace function public.sk_create_order(
  p_customer_id uuid,
  p_items jsonb,
  p_note text default null,
  p_client_request_id uuid default gen_random_uuid(),
  p_payment_method text default null,
  p_payment_bank text default null
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
    order_number, customer_id, total_amount, payment_method, payment_bank,
    note, client_request_id
  ) values (
    v_order_number, p_customer_id, v_total, nullif(p_payment_method, ''),
    nullif(p_payment_bank, ''), nullif(left(coalesce(p_note,''),1000),''),
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

revoke all on function public.sk_create_order(uuid,jsonb,text,uuid,text,text) from public, anon, authenticated;
grant execute on function public.sk_create_order(uuid,jsonb,text,uuid,text,text) to service_role;
