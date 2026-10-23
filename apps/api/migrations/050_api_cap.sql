-- Nimbus's own Salesforce API calls per org and hour (the org total also includes the customer's other tools),
-- and an optional daily cap an admin sets so Nimbus leaves room for those tools.
create table if not exists api_calls_hourly (
  tenant_id uuid not null references tenants(id) on delete cascade,
  hour timestamptz not null,
  calls int not null default 0,
  primary key (tenant_id, hour)
);
alter table tenants add column if not exists api_cap int;
