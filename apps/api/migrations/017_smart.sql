-- Smart features: suggestion dismissals, workspace rules, approval notes, real-time triggers.
create table if not exists suggestion_dismissals (
  tenant_id uuid not null references tenants(id) on delete cascade,
  key text not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, key)
);

create table if not exists policies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  text text not null,
  rule jsonb not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists policies_tenant_idx on policies (tenant_id);

-- Why a person rejected (or what they noted when approving): feeds agent health.
alter table runs add column if not exists decision_note text;
alter table runs add column if not exists decided_at timestamptz;

-- Real-time triggers via Change Data Capture; replay id survives restarts.
alter table workflows add column if not exists realtime boolean not null default false;
create table if not exists stream_state (
  tenant_id uuid not null references tenants(id) on delete cascade,
  channel text not null,
  replay_id bigint,
  error text,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, channel)
);
