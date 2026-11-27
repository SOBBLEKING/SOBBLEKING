-- SOBBLEKING member number: SKM- + 8 uppercase alphanumeric characters.
-- Additive only: preserves customer UUIDs, orders, wallets, and transaction history.
-- The canonical customer identity for orders and wallets is public.customers.

alter table public.customers
  add column if not exists member_code text;

create or replace function public.sk_generate_member_code()
returns text
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_chars constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code text;
  i integer;
begin
  loop
    v_code := 'SKM-';
    for i in 1..8 loop
      v_code := v_code || substr(v_chars, floor(random() * length(v_chars))::integer + 1, 1);
    end loop;
    exit when not exists (
      select 1 from public.customers where member_code = v_code
    );
  end loop;
  return v_code;
end;
$function$;

-- Backfill only missing member numbers. Internal UUIDs and related records are untouched.
do $backfill$
declare
  v_customer_id uuid;
begin
  for v_customer_id in
    select id
    from public.customers
    where member_code is null or btrim(member_code) = ''
    order by created_at nulls first, id
  loop
    update public.customers
    set member_code = public.sk_generate_member_code()
    where id = v_customer_id;
  end loop;
end;
$backfill$;

create unique index if not exists customers_member_code_uidx
  on public.customers(member_code);

alter table public.customers
  alter column member_code set not null;

create or replace function public.sk_set_customer_member_code()
returns trigger
language plpgsql
security definer
set search_path = public
as $trigger$
begin
  if new.member_code is null or btrim(new.member_code) = '' then
    new.member_code := public.sk_generate_member_code();
  end if;
  return new;
end;
$trigger$;

-- Create the trigger only when absent; no existing triggers are dropped or replaced.
do $install$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.customers'::regclass
      and tgname = 'sk_customers_member_code_before_write'
      and not tgisinternal
  ) then
    create trigger sk_customers_member_code_before_write
    before insert or update of member_code on public.customers
    for each row execute function public.sk_set_customer_member_code();
  end if;
end;
$install$;

revoke all on function public.sk_generate_member_code() from public, anon, authenticated;
revoke all on function public.sk_set_customer_member_code() from public, anon, authenticated;
