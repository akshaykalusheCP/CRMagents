-- Team: invitations by email with a role, and password reset links. Tokens are stored hashed.
create table if not exists invites (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  email text not null,
  role text not null,
  token_hash text not null unique,
  invited_by text,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists invites_account_idx on invites (account_id);

create table if not exists password_resets (
  token_hash text primary key,
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

alter table users add column if not exists last_login_at timestamptz;

-- Alerts: what went wrong that a person should know about (agent failing again and again, org disconnected).
create table if not exists alerts (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  tenant_id uuid references tenants(id) on delete cascade,
  workflow_id uuid references workflows(id) on delete cascade,
  kind text not null,
  title text not null,
  body text not null default '',
  emailed boolean not null default false,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists alerts_account_idx on alerts (account_id, created_at desc);

-- An agent paused automatically after failing again and again (or by a person): it does not start until resumed.
alter table workflows add column if not exists paused_reason text;

-- Rate limits shared by every API instance (login attempts, website chat, reset emails).
create table if not exists rate_limits (
  key text primary key,
  n int not null,
  reset_at timestamptz not null
);
