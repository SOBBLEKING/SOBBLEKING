-- SOBBLEKING：下單功能開發前的資料庫結構檢查（唯讀，不會修改資料）
-- 請在 Supabase SQL Editor 執行，將完整結果貼回對話。

-- 1. 訂單／會員／商品／優惠券／錢包相關資料表欄位
select
  table_name,
  ordinal_position,
  column_name,
  data_type,
  is_nullable,
  column_default
from information_schema.columns
where table_schema = 'public'
  and table_name in (
    'orders',
    'order_items',
    'customers',
    'sobbstars_members',
    'products',
    'coupons',
    'coupon_redemptions',
    'wallet_accounts',
    'wallet_transactions'
  )
order by table_name, ordinal_position;

-- 2. 上述資料表的主鍵、外鍵、唯一與檢查約束
select
  tc.table_name,
  tc.constraint_name,
  tc.constraint_type,
  kcu.column_name,
  ccu.table_name as foreign_table_name,
  ccu.column_name as foreign_column_name,
  check_constraints.check_clause
from information_schema.table_constraints tc
left join information_schema.key_column_usage kcu
  on tc.constraint_schema = kcu.constraint_schema
 and tc.constraint_name = kcu.constraint_name
 and tc.table_name = kcu.table_name
left join information_schema.constraint_column_usage ccu
  on tc.constraint_schema = ccu.constraint_schema
 and tc.constraint_name = ccu.constraint_name
left join information_schema.check_constraints
  on tc.constraint_schema = check_constraints.constraint_schema
 and tc.constraint_name = check_constraints.constraint_name
where tc.constraint_schema = 'public'
  and tc.table_name in (
    'orders',
    'order_items',
    'customers',
    'sobbstars_members',
    'products',
    'coupons',
    'coupon_redemptions',
    'wallet_accounts',
    'wallet_transactions'
  )
order by tc.table_name, tc.constraint_type, tc.constraint_name;

-- 3. 訂單／錢包相關自訂函式（只列定義，不執行）
select
  p.proname as function_name,
  pg_get_function_identity_arguments(p.oid) as arguments,
  pg_get_function_result(p.oid) as return_type,
  pg_get_functiondef(p.oid) as definition
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and (
    p.proname ilike '%order%'
    or p.proname ilike '%wallet%'
    or p.proname ilike '%coupon%'
  )
order by p.proname;
