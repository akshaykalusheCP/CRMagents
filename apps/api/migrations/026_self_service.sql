-- Website chat self-service: visitors prove their email with a one-time code, then see their own records and run
-- the actions the admin allowed.
alter table agents add column if not exists public_config jsonb not null default '{}';
create table if not exists public_sessions (
  id uuid primary key,
  agent_id uuid not null references agents(id) on delete cascade,
  email text,
  code_hash text,
  code_sent_at timestamptz,
  codes_sent int not null default 0,
  attempts int not null default 0,
  verified_at timestamptz,
  contact_id text,
  account_id text,
  name text,
  created_at timestamptz not null default now()
);
create index if not exists public_sessions_email_idx on public_sessions (lower(email), code_sent_at);
