-- SOBBLEKING member code: SKM- + 8 uppercase alphanumeric characters
-- Existing customer UUIDs remain unchanged; this adds a stable public-facing member number.

alter table public.customers
  add column if not exists member_code text;

create or replace function public.sk_generate_member_code()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
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
$$;

-- Backfill existing members without changing their internal UUIDs.
do $$
declare
  v_customer record;
begin
  for v_customer in
    select id from public.customers
    where member_code is null or btrim(member_code) = ''
    order by created_at nulls first, id
  loop
    update public.customers
    set member_code = public.sk_generate_member_code()
    where id = v_customer.id;
  end loop;
end;
$$;

create unique index if not exists customers_member_code_uidx
  on public.customers(member_code);

alter table public.customers
  alter column member_code set not null;

create or replace function public.sk_set_customer_member_code()
returns trigger
language plpgsql
security definer
set search_path = public
as $
begin
  if new.member_code is null or btrim(new.member_code) = '' then
    new.member_code := public.sk_generate_member_code();
  end if;
  return new;
end;
$;

drop trigger if exists sk_customers_member_code_before_write on public.customers;
create trigger sk_customers_member_code_before_write
before insert or update of member_code on public.customers
for each row execute function public.sk_set_customer_member_code();

-- The storefront's LINE member card is backed by sobbstars_members.
-- Keep its public member code identical to customers when the LINE userId matches.
do $
begin
  if to_regclass('public.sobbstars_members') is not null then
    execute 'alter table public.sobbstars_members add column if not exists member_code text';
    execute $sql$
      update public.sobbstars_members as m
      set member_code = c.member_code
      from public.customers as c
      where m.line_user_id = c.line_user_id
        and coalesce(m.member_code, '') = ''
        and coalesce(c.line_user_id, '') <> ''
    $sql$;
    execute $sql$
      update public.sobbstars_members
      set member_code = public.sk_generate_member_code()
      where member_code is null or btrim(member_code) = ''
    $sql$;
    execute 'create unique index if not exists sobbstars_members_member_code_uidx on public.sobbstars_members(member_code)';
    execute 'alter table public.sobbstars_members alter column member_code set not null';
    execute 'drop trigger if exists sk_sobbstars_members_member_code_before_write on public.sobbstars_members';
    execute 'create trigger sk_sobbstars_members_member_code_before_write before insert or update of member_code on public.sobbstars_members for each row execute function public.sk_set_customer_member_code()';
  end if;
end;
$;

revoke all on function public.sk_generate_member_code() from public, anon, authenticated;
revoke all on function public.sk_set_customer_member_code() from public, anon, authenticated;
