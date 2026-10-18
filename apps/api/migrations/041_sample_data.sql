-- Sample data loaded into a test org: exactly which records it created, so "Remove" deletes only those.
create table if not exists sample_records (
  tenant_id uuid not null references tenants(id) on delete cascade,
  object text not null,
  record_id text not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, record_id)
);
