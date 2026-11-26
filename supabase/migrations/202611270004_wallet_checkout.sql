-- SOBBLEKING: wallet-first checkout with optional split payment.
-- Wallet deduction, order creation, and ledger entry are one database transaction.

alter table public.sk_orders
  add column if not exists wallet_amount_used numeric(12,2) not null default 0
    check (wallet_amount_used >= 0),
  add column if not exists external_due numeric(12,2) not null default 0
    check (external_due >= 0);

update public.sk_orders
set external_due = total_amount
where payment_status = 'unpaid'
  and wallet_amount_used = 0
  and external_due = 0;

create unique index if not exists sk_wallet_transactions_purchase_once_idx
  on public.sk_wallet_transactions(reference_id)
  where reference_id is not null and transaction_type = 'purchase';

create or replace function public.sk_create_order(
  p_customer_id uuid,
  p_items jsonb,
  p_note text default null,
  p_client_request_id uuid default gen_random_uuid(),
  p_payment_method text default null,
  p_payment_bank text default null,
  p_use_wallet boolean default true
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
  v_wallet public.sk_wallet_accounts%rowtype;
  v_wallet_before numeric(12,2) := 0;
  v_wallet_used numeric(12,2) := 0;
  v_external_due numeric(12,2) := 0;
  v_payment_method text;
  v_payment_bank text;
  v_payment_status text := 'unpaid';
  v_paid_at timestamptz;
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
    and client_request_id = p_client_request_id
  for update;

  if found then
    return jsonb_build_object(
      'success', true,
      'order_id', v_existing.id,
      'order_number', v_existing.order_number,
      'total_amount', v_existing.total_amount,
      'wallet_amount_used', coalesce(v_existing.wallet_amount_used, 0),
      'external_due', coalesce(v_existing.external_due, v_existing.total_amount),
      'payment_method', v_existing.payment_method,
      'payment_status', v_existing.payment_status,
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

    select id, name, price into v_product
    from public.products
    where id = (v_item->>'product_id')::uuid
      and is_active = true
    for share;

    if not found then raise exception 'product_unavailable'; end if;
    if v_product.price is null or v_product.price < 0 then
      raise exception 'invalid_product_price';
    end if;
    v_total := v_total + (v_product.price * v_qty);
  end loop;

  if p_use_wallet then
    insert into public.sk_wallet_accounts(customer_id, balance)
    values (p_customer_id, 0)
    on conflict (customer_id) do nothing;

    select * into v_wallet
    from public.sk_wallet_accounts
    where customer_id = p_customer_id
    for update;

    v_wallet_before := v_wallet.balance;
    v_wallet_used := least(v_wallet_before, v_total);
  end if;

  v_external_due := v_total - v_wallet_used;
  if v_external_due > 0 then
    if coalesce(p_payment_method, '') not in ('無卡存款', '銀行匯款', 'LINE Pay') then
      raise exception 'invalid_payment_method';
    end if;
    if p_payment_method = '無卡存款' then
      if coalesce(p_payment_bank, '') not in ('國泰世華（013）','台新銀行（812）','郵局（700）','中國信託（822）') then
        raise exception 'invalid_payment_bank';
      end if;
      v_payment_bank := p_payment_bank;
    else
      v_payment_bank := null;
    end if;
    v_payment_method := p_payment_method;
  else
    v_payment_method := '會員卡餘額';
    v_payment_bank := null;
    v_payment_status := 'paid';
    v_paid_at := now();
  end if;

  loop
    v_order_number := 'SKD-';
    for i in 1..8 loop
      v_order_number := v_order_number || substr(v_chars, floor(random()*length(v_chars))::integer + 1, 1);
    end loop;
    exit when not exists (select 1 from public.sk_orders where order_number = v_order_number);
  end loop;

  insert into public.sk_orders (
    order_number, customer_id, total_amount, payment_status, order_status, payment_method,
    payment_bank, note, client_request_id, wallet_amount_used, external_due, paid_at
  ) values (
    v_order_number, p_customer_id, v_total, v_payment_status,
    case when v_payment_status = 'paid' then 'processing' else 'pending' end,
    v_payment_method, v_payment_bank, nullif(left(coalesce(p_note,''),1000),''), p_client_request_id,
    v_wallet_used, v_external_due, v_paid_at
  ) returning id into v_order_id;

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

  if v_wallet_used > 0 then
    update public.sk_wallet_accounts
    set balance = v_wallet_before - v_wallet_used, updated_at = now()
    where id = v_wallet.id;

    insert into public.sk_wallet_transactions(
      wallet_id, customer_id, transaction_type, amount,
      balance_before, balance_after, reference_id, description
    ) values (
      v_wallet.id, p_customer_id, 'purchase', -v_wallet_used,
      v_wallet_before, v_wallet_before - v_wallet_used, v_order_id,
      '訂單 ' || v_order_number || ' 使用會員卡餘額付款'
    );
  end if;

  return jsonb_build_object(
    'success', true,
    'order_id', v_order_id,
    'order_number', v_order_number,
    'total_amount', v_total,
    'wallet_amount_used', v_wallet_used,
    'wallet_balance_after', v_wallet_before - v_wallet_used,
    'external_due', v_external_due,
    'payment_method', v_payment_method,
    'payment_status', v_payment_status,
    'verification_code', v_code,
    'reused', false
  );
end;
$$;

revoke all on function public.sk_create_order(uuid,jsonb,text,uuid,text,text,boolean)
  from public, anon, authenticated;
grant execute on function public.sk_create_order(uuid,jsonb,text,uuid,text,text,boolean)
  to service_role;
