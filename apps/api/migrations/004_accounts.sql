create table if not exists accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  email text not null,
  password_hash text not null,
  role text not null default 'owner',
  created_at timestamptz not null default now()
);
create unique index if not exists users_email_key on users (lower(email));

create table if not exists sessions (
  token_hash text primary key,
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- Connected Salesforce orgs now belong to an account. The same org may be connected by different accounts.
alter table tenants add column if not exists account_id uuid references accounts(id) on delete cascade;
alter table tenants drop constraint if exists tenants_sf_org_id_key;
create unique index if not exists tenants_account_org_key on tenants (account_id, sf_org_id);

-- Settings: zero-uuid account = platform default; per-account rows override it.
alter table settings add column if not exists account_id uuid not null default '00000000-0000-0000-0000-000000000000';
alter table settings drop constraint if exists settings_pkey;
alter table settings add primary key (account_id, key);
