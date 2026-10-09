create table if not exists tenants (
  id uuid primary key default gen_random_uuid(),
  sf_org_id text not null unique,
  sf_instance_url text not null,
  sf_username text,
  refresh_token_enc text not null,
  created_at timestamptz not null default now()
);

create table if not exists agents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  system_prompt text not null default '',
  tools text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  agent_id uuid references agents(id) on delete set null,
  status text not null default 'running',
  input jsonb,
  output text,
  trace jsonb not null default '[]',
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  created_at timestamptz not null default now()
);
