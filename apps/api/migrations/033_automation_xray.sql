-- Automation X-ray: the latest inventory of an org's Flows, Process Builders, Workflow Rules and Apex triggers.
create table if not exists automation_scans (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  result jsonb not null,
  scanned_at timestamptz not null default now()
);
