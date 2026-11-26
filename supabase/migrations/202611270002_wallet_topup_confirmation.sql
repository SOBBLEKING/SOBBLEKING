-- SOBBLEKING wallet top-up confirmation workflow
-- Confirmation is atomic: request status, wallet credit, bonus, and audit trail commit together.

alter table public.sk_wallet_topup_requests
  add column if not exists received_amount integer,
  add column if not exists excess_amount integer not null default 0,
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by text;

create or replace function public.sk_confirm_wallet_topup(
  p_request_id uuid,
  p_received_amount integer,
  p_admin_email text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.sk_wallet_topup_requests%rowtype;
  v_wallet public.sk_wallet_accounts%rowtype;
  v_bonus integer := 0;
  v_excess integer := 0;
  v_credit integer := 0;
  v_before numeric(12,2) := 0;
  v_after numeric(12,2) := 0;
  v_campaign_id uuid;
  v_now timestamptz := now();
begin
  if p_request_id is null or p_received_amount is null or p_received_amount < 0
     or coalesce(trim(p_admin_email),'') = '' then
    raise exception 'invalid_confirmation_input';
  end if;

  select * into v_request
  from public.sk_wallet_topup_requests
  where id = p_request_id
  for update;

  if not found then raise exception 'topup_request_not_found'; end if;
  if v_request.status <> 'pending' then raise exception 'topup_request_not_pending'; end if;
  if p_received_amount < v_request.amount then raise exception 'received_amount_less_than_requested'; end if;

  if v_request.payment_method = '無卡存款' then
    v_excess := p_received_amount - v_request.amount;
  else
    if p_received_amount <> v_request.amount then
      raise exception 'received_amount_must_match_request';
    end if;
    v_excess := 0;
  end if;

  select id, bonus_amount into v_campaign_id, v_bonus
  from public.sk_topup_campaigns
  where is_active = true
    and min_amount <= v_request.amount
    and (starts_at is null or starts_at <= v_now)
    and (ends_at is null or ends_at > v_now)
  order by min_amount desc, created_at desc
  limit 1;

  v_bonus := coalesce(v_bonus, 0);
  v_credit := v_request.amount + v_excess;
  insert into public.sk_wallet_accounts(customer_id, balance)
  values (v_request.customer_id, 0)
  on conflict (customer_id) do nothing;

  select * into v_wallet
  from public.sk_wallet_accounts
  where customer_id = v_request.customer_id
  for update;

  v_before := v_wallet.balance;
  v_after := v_before + v_credit + v_bonus;

  update public.sk_wallet_accounts
  set balance = v_after, updated_at = v_now
  where id = v_wallet.id;

  insert into public.sk_wallet_transactions(
    wallet_id, customer_id, transaction_type, amount, balance_before, balance_after,
    reference_id, description, admin_email
  ) values (
    v_wallet.id, v_request.customer_id, 'topup', v_credit, v_before,
    v_before + v_credit, v_request.id,
    case when v_excess > 0
      then '儲值本金 NT$' || v_request.amount || '＋無卡存款超額 NT$' || v_excess
      else '會員錢包儲值本金'
    end,
    lower(trim(p_admin_email))
  );

  if v_bonus > 0 then
    insert into public.sk_wallet_transactions(
      wallet_id, customer_id, transaction_type, amount, balance_before, balance_after,
      reference_id, description, admin_email
    ) values (
      v_wallet.id, v_request.customer_id, 'topup_bonus', v_bonus,
      v_before + v_credit, v_after, v_request.id,
      '儲值活動贈送', lower(trim(p_admin_email))
    );
  end if;

  update public.sk_wallet_topup_requests
  set status = 'confirmed',
      received_amount = p_received_amount,
      excess_amount = v_excess,
      confirmed_at = v_now,
      reviewed_at = v_now,
      reviewed_by = lower(trim(p_admin_email)),
      updated_at = v_now,
      admin_note = case when v_excess > 0
        then '實收 NT$' || p_received_amount || '；超額 NT$' || v_excess || ' 已存入錢包'
        else coalesce(admin_note, '')
      end
  where id = p_request_id;

  insert into public.sk_admin_audit_logs(admin_email, action, target_type, target_id, details)
  values (
    lower(trim(p_admin_email)), 'confirm_wallet_topup', 'wallet_topup', p_request_id::text,
    jsonb_build_object(
      'requested_amount', v_request.amount,
      'received_amount', p_received_amount,
      'excess_amount', v_excess,
      'bonus_amount', v_bonus,
      'wallet_credit', v_credit + v_bonus,
      'balance_before', v_before,
      'balance_after', v_after
    )
  );

  return jsonb_build_object(
    'success', true, 'request_id', p_request_id,
    'requested_amount', v_request.amount, 'received_amount', p_received_amount,
    'excess_amount', v_excess, 'bonus_amount', v_bonus,
    'wallet_credit', v_credit + v_bonus,
    'balance_before', v_before, 'balance_after', v_after
  );
end;
$$;

create or replace function public.sk_reject_wallet_topup(
  p_request_id uuid,
  p_admin_email text,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.sk_wallet_topup_requests%rowtype;
  v_now timestamptz := now();
  v_reason text := left(trim(coalesce(p_reason,'')), 500);
begin
  if p_request_id is null or coalesce(trim(p_admin_email),'') = '' or v_reason = '' then
    raise exception 'rejection_reason_required';
  end if;

  select * into v_request
  from public.sk_wallet_topup_requests
  where id = p_request_id
  for update;

  if not found then raise exception 'topup_request_not_found'; end if;
  if v_request.status <> 'pending' then raise exception 'topup_request_not_pending'; end if;

  update public.sk_wallet_topup_requests
  set status = 'rejected', admin_note = v_reason,
      reviewed_at = v_now, reviewed_by = lower(trim(p_admin_email)),
      updated_at = v_now
  where id = p_request_id;

  insert into public.sk_admin_audit_logs(admin_email, action, target_type, target_id, details)
  values (
    lower(trim(p_admin_email)), 'reject_wallet_topup', 'wallet_topup', p_request_id::text,
    jsonb_build_object('amount', v_request.amount, 'reason', v_reason)
  );

  return jsonb_build_object('success', true, 'request_id', p_request_id, 'status', 'rejected');
end;
$$;

revoke all on function public.sk_confirm_wallet_topup(uuid, integer, text) from public, anon, authenticated;
revoke all on function public.sk_reject_wallet_topup(uuid, text, text) from public, anon, authenticated;
grant execute on function public.sk_confirm_wallet_topup(uuid, integer, text) to service_role;
grant execute on function public.sk_reject_wallet_topup(uuid, text, text) to service_role;
