-- Test sets for assistants: questions with what a good answer says, run before changes go live.
create table if not exists assistant_tests (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents(id) on delete cascade,
  question text not null,
  expect text not null default '',
  must_include text[] not null default '{}',
  must_not text[] not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists assistant_tests_agent_idx on assistant_tests (agent_id, created_at);

create table if not exists assistant_test_runs (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents(id) on delete cascade,
  channel text not null default 'internal',
  status text not null default 'running',
  passed int not null default 0,
  total int not null default 0,
  cost_usd numeric not null default 0,
  results jsonb not null default '[]',
  started_by text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists assistant_test_runs_agent_idx on assistant_test_runs (agent_id, created_at desc);
