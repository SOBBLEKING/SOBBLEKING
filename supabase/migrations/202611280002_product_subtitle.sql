alter table public.products
  add column if not exists subtitle text;

comment on column public.products.subtitle is
  'Optional customer-facing product subtitle managed by SOBBLEKING admin.';
