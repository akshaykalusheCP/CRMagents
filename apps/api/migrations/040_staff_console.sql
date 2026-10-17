-- Staff console: how CRMagents staff organise clients.
alter table accounts add column if not exists tags text[] not null default '{}';
alter table accounts add column if not exists staff_owner text;
create table if not exists account_notes (
  id bigserial primary key,
  account_id uuid not null references accounts(id) on delete cascade,
  author text not null,
  text text not null,
  created_at timestamptz not null default now()
);
create index if not exists account_notes_idx on account_notes (account_id, created_at desc);
alter table sales_inquiries add column if not exists assigned_to text;
