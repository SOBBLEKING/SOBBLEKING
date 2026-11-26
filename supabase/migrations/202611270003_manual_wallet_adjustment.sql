-- SOBBLEKING: atomic manual wallet credits/debits with immutable audit records.
-- Amount is always a positive integer; direction determines credit or debit.

create or replace function public.sk_manual_wallet_adjustment(
  p_customer_id uuid,
  p_direction text,
  p_amount integer,
  p_reason text,
  p_admin_email text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wallet public.sk_wallet_accounts%rowtype;
  v_before numeric(12,2);
  v_after numeric(12,2);
  v_delta numeric(12,2);
  v_reason text := left(trim(coalesce(p_reason, '')), 500);
  v_admin text := lower(trim(coalesce(p_admin_email, '')));
  v_type text;
  v_now timestamptz := now();
begin
  if p_customer_id is null
     or p_direction not in ('credit', 'debit')
     or p_amount is null or p_amount <= 0
     or v_reason = ''
     or v_admin = '' then
    raise exception 'invalid_wallet_adjustment_input';
  end if;

  insert into public.sk_wallet_accounts(customer_id, balance)
  values (p_customer_id, 0)
  on conflict (customer_id) do nothing;

  select * into v_wallet
  from public.sk_wallet_accounts
  where customer_id = p_customer_id
  for update;

  if not found then raise exception 'wallet_not_found'; end if;

  v_before := v_wallet.balance;
  if p_direction = 'credit' then
    v_delta := p_amount;
    v_type := 'manual_credit';
  else
    v_delta := -p_amount;
    v_type := 'manual_debit';
    if v_before < p_amount then
      raise exception 'insufficient_wallet_balance';
    end if;
  end if;

  v_after := v_before + v_delta;

  update public.sk_wallet_accounts
  set balance = v_after, updated_at = v_now
  where id = v_wallet.id;

  insert into public.sk_wallet_transactions(
    wallet_id, customer_id, transaction_type, amount,
    balance_before, balance_after, description, admin_email, created_at
  ) values (
    v_wallet.id, p_customer_id, v_type, v_delta,
    v_before, v_after, v_reason, v_admin, v_now
  );

  insert into public.sk_admin_audit_logs(
    admin_email, action, target_type, target_id, details, created_at
  ) values (
    v_admin,
    case when p_direction = 'credit' then 'manual_wallet_credit' else 'manual_wallet_debit' end,
    'customer', p_customer_id::text,
    jsonb_build_object(
      'direction', p_direction,
      'amount', p_amount,
      'reason', v_reason,
      'balance_before', v_before,
      'balance_after', v_after,
      'wallet_transaction_type', v_type
    ),
    v_now
  );

  return jsonb_build_object(
    'success', true,
    'customer_id', p_customer_id,
    'direction', p_direction,
    'amount', p_amount,
    'reason', v_reason,
    'balance_before', v_before,
    'balance_after', v_after,
    'transaction_type', v_type,
    'created_at', v_now
  );
end;
$$;

revoke all on function public.sk_manual_wallet_adjustment(uuid, text, integer, text, text)
  from public, anon, authenticated;
grant execute on function public.sk_manual_wallet_adjustment(uuid, text, integer, text, text)
  to service_role;
