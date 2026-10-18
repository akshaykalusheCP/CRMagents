-- Staff-only changes that don't belong in the customer's own audit log (tags, who looks after them, notes removed).
create table if not exists staff_events (
  id bigserial primary key,
  account_id uuid references accounts(id) on delete cascade,
  by_email text not null,
  what text not null,
  detail text,
  created_at timestamptz not null default now()
);
create index if not exists staff_events_idx on staff_events (created_at desc);
