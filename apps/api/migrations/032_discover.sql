-- "What to automate": the latest scan of an org (counts only), and agents built from it with their proof.
create table if not exists discoveries (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  result jsonb not null,
  scanned_at timestamptz not null default now()
);
create table if not exists discovery_builds (
  tenant_id uuid not null references tenants(id) on delete cascade,
  opportunity text not null,
  workflow_id uuid references workflows(id) on delete set null,
  proof jsonb not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, opportunity)
);
