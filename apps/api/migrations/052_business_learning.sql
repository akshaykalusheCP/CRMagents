-- Lessons from people's decisions on an agent's proposals: an approval or rejection with a note becomes something the
-- agent reads next time it proposes something similar (closest few, picked by word overlap, no AI).
create table if not exists agent_lessons (
  id bigserial primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  workflow_id uuid not null references workflows(id) on delete cascade,
  run_id uuid,
  approved boolean not null,
  proposal text not null,
  note text not null,
  decided_by text,
  created_at timestamptz not null default now()
);
create index if not exists agent_lessons_wf_idx on agent_lessons (workflow_id, created_at desc);
