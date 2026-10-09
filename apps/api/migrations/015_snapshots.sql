-- One snapshot of key business numbers per org per day: history that Salesforce itself does not keep.
create table if not exists kpi_snapshots (
  tenant_id uuid not null references tenants(id) on delete cascade,
  day date not null,
  data jsonb not null,
  primary key (tenant_id, day)
);
