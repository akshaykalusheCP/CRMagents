-- Change log for undo: every record an agent or assistant created, changed or deleted, with what it replaced.
create table if not exists run_changes (
  id bigserial primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  run_id uuid not null references runs(id) on delete cascade,
  workflow_id uuid references workflows(id) on delete set null,
  agent_id uuid references agents(id) on delete set null,
  op text not null,               -- create | update | delete
  object text not null,
  record_id text not null,
  before jsonb,
  after jsonb,
  undoable boolean not null default true,
  undone_at timestamptz,
  undone_by text,
  undo_result text,
  created_at timestamptz not null default now()
);
create index if not exists run_changes_run_idx on run_changes (run_id);
create index if not exists run_changes_wf_idx on run_changes (workflow_id, created_at desc);
create index if not exists run_changes_tenant_idx on run_changes (tenant_id, created_at desc);
