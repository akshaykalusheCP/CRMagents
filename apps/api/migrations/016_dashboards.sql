-- Prompt-built dashboards: the AI drafts tiles once; afterwards tiles re-run their saved queries ($0 AI).
create table if not exists dashboards (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  description text not null default '',
  prompt text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists dashboard_tiles (
  id uuid primary key default gen_random_uuid(),
  dashboard_id uuid not null references dashboards(id) on delete cascade,
  position int not null default 0,
  title text not null,
  question text not null default '',
  soql text not null,
  chart text not null,
  label_key text not null default '',
  series_key text not null default '',
  value_key text not null default '',
  format text not null default 'number',
  date_field text not null default '',
  drill_soql text not null default '',
  size text not null default 'half'
);
create index if not exists dashboard_tiles_dash_idx on dashboard_tiles (dashboard_id, position);
