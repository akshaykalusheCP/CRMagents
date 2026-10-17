-- "Contact sales" from the pricing section (Pro Max).
create table if not exists sales_inquiries (
  id bigserial primary key,
  name text not null,
  email text not null,
  company text not null,
  size text,
  message text,
  ip text,
  created_at timestamptz not null default now()
);
