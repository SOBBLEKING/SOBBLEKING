-- SOBBLEKING: order payment confirmation with received amount and cardless overpayment wallet credit.
-- The order row lock makes payment confirmation and wallet credit atomic and idempotent.

alter table public.sk_orders
  add column if not exists received_amount integer,
  add column if not exists excess_amount integer not null default 0,
  add column if not exists excess_wallet_credited boolean not null default false;

create or replace function public.sk_confirm_order_payment(
  p_order_id uuid,
  p_received_amount integer,
  p_admin_email text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.sk_orders%rowtype;
  v_wallet public.sk_wallet_accounts%rowtype;
  v_due integer;
  v_excess integer := 0;
  v_wallet_credit integer := 0;
  v_balance_before numeric(12,2);
  v_balance_after numeric(12,2);
  v_now timestamptz := now();
begin
  if p_order_id is null or p_received_amount is null or p_received_amount < 0
     or coalesce(trim(p_admin_email), '') = '' then
    raise exception 'invalid_payment_confirmation_input';
  end if;

  select * into v_order
  from public.sk_orders
  where id = p_order_id
  for update;

  if not found then raise exception 'order_not_found'; end if;
  if v_order.payment_status <> 'unpaid' then raise exception 'order_payment_not_pending'; end if;

  v_due := ceil(coalesce(v_order.external_due, v_order.total_amount - coalesce(v_order.wallet_amount_used, 0)))::integer;
  if p_received_amount < v_due then
    raise exception 'received_amount_less_than_external_due';
  end if;

  v_excess := p_received_amount - v_due;

  if v_excess > 0 and v_order.payment_method = '無卡存款' then
    insert into public.sk_wallet_accounts(customer_id, balance)
    values (v_order.customer_id, 0)
    on conflict (customer_id) do nothing;

    select * into v_wallet
    from public.sk_wallet_accounts
    where customer_id = v_order.customer_id
    for update;

    v_balance_before := v_wallet.balance;
    v_balance_after := v_balance_before + v_excess;
    v_wallet_credit := v_excess;

    update public.sk_wallet_accounts
    set balance = v_balance_after, updated_at = v_now
    where id = v_wallet.id;

    insert into public.sk_wallet_transactions(
      wallet_id, customer_id, transaction_type, amount,
      balance_before, balance_after, reference_id, description, admin_email, created_at
    ) values (
      v_wallet.id, v_order.customer_id, 'adjustment', v_excess,
      v_balance_before, v_balance_after, v_order.id,
      '訂單 ' || v_order.order_number || ' 無卡存款超額 NT$' || v_excess || ' 自動存入會員錢包',
      lower(trim(p_admin_email)), v_now
    );
  end if;

  update public.sk_orders
  set payment_status = 'paid',
      order_status = case when order_status = 'pending' then 'processing' else order_status end,
      paid_at = v_now,
      received_amount = p_received_amount,
      excess_amount = v_excess,
      excess_wallet_credited = (v_wallet_credit > 0),
      updated_at = v_now
  where id = p_order_id;

  insert into public.sk_admin_audit_logs(
    admin_email, action, target_type, target_id, details, created_at
  ) values (
    lower(trim(p_admin_email)), 'confirm_order_payment', 'order', p_order_id::text,
    jsonb_build_object(
      'order_number', v_order.order_number,
      'total_amount', v_order.total_amount,
      'wallet_amount_used', coalesce(v_order.wallet_amount_used, 0),
      'external_due', v_due,
      'received_amount', p_received_amount,
      'excess_amount', v_excess,
      'excess_wallet_credited', v_wallet_credit > 0,
      'wallet_balance_before', v_balance_before,
      'wallet_balance_after', v_balance_after
    ),
    v_now
  );

  return jsonb_build_object(
    'success', true,
    'order_id', p_order_id,
    'order_number', v_order.order_number,
    'total_amount', v_order.total_amount,
    'wallet_amount_used', coalesce(v_order.wallet_amount_used, 0),
    'external_due', v_due,
    'received_amount', p_received_amount,
    'excess_amount', v_excess,
    'wallet_credit', v_wallet_credit,
    'wallet_balance_before', v_balance_before,
    'wallet_balance_after', v_balance_after,
    'uncredited_excess', case when v_order.payment_method = '無卡存款' then 0 else v_excess end,
    'payment_status', 'paid'
  );
end;
$$;

revoke all on function public.sk_confirm_order_payment(uuid, integer, text)
  from public, anon, authenticated;
grant execute on function public.sk_confirm_order_payment(uuid, integer, text)
  to service_role;
