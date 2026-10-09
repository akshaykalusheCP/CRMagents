-- Cached Salesforce describe results per org (object list, object fields) so drafting workflows is fast and free.
create table if not exists sf_schema_cache (
  tenant_id uuid not null references tenants(id) on delete cascade,
  key text not null,
  data jsonb not null,
  fetched_at timestamptz not null default now(),
  primary key (tenant_id, key)
);
