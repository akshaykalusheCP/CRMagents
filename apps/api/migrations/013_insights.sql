-- Questions pinned to the Insights dashboard; re-run on load with no AI cost.
create table if not exists insight_tiles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  title text not null,
  question text not null,
  soql text not null,
  chart text not null,
  label_key text not null default '',
  value_key text not null default '',
  created_at timestamptz not null default now()
);
