create table if not exists workflows (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  graph jsonb not null default '{"nodes":[],"edges":[]}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table runs add column if not exists workflow_id uuid references workflows(id) on delete set null;
alter table runs add column if not exists steps jsonb not null default '[]';
alter table runs add column if not exists state jsonb;
