-- Corrections and confirmations of AI decisions, used as few-shot examples for the same workflow block.
create table if not exists ai_examples (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  workflow_id uuid not null references workflows(id) on delete cascade,
  node_id text not null,
  input text not null,
  label text not null,
  source text not null check (source in ('correction', 'confirmed')),
  created_at timestamptz not null default now()
);
create index if not exists ai_examples_node_idx on ai_examples (workflow_id, node_id, created_at desc);
