-- Persist the administrator-controlled product display order.
alter table public.products
  add column if not exists sort_order integer;

-- Preserve the storefront's existing hard-coded order for the original products.
with ranked_products as (
  select
    id,
    row_number() over (
      order by
        case id::text
          when '1286da0d-f4a9-4e5a-a9e0-786dc0bd7a15' then 1
          when '67a43987-eb2e-4c5b-8d3e-048096a1886a' then 2
          when '56a8a843-3c62-41ea-b5e5-06095126e174' then 3
          when 'f2834df7-1133-4682-9e50-6ba35f046bbc' then 4
          when 'c78f7bcd-b742-4cf9-9a97-9defc47d50d5' then 5
          when 'd968722b-643a-4069-9b42-5ff3cc2e3781' then 6
          when 'defa3200-2582-4bc1-b070-2bd4b26a3d4c' then 7
          when '633be96f-0531-4e3d-babc-6e9a646d7c80' then 8
          else 1000
        end,
        name asc,
        id asc
    ) as position
  from public.products
)
update public.products as p
set sort_order = ranked_products.position
from ranked_products
where p.id = ranked_products.id
  and p.sort_order is null;

alter table public.products
  alter column sort_order set default 0;

create index if not exists products_sort_order_idx
  on public.products (sort_order, name);
