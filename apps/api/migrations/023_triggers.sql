-- Record checks per object (agents can watch several objects), last-seen values for "only when these fields
-- change", and webhook secrets.
alter table workflows add column if not exists watch_state jsonb not null default '{}';
alter table workflows add column if not exists webhook_secret_enc text;
create table if not exists trigger_values (
  workflow_id uuid not null references workflows(id) on delete cascade,
  record_id text not null,
  vals jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (workflow_id, record_id)
);
-- Versions of each agent, newest first, so a change can be undone.
create table if not exists workflow_versions (
  id bigserial primary key,
  workflow_id uuid not null references workflows(id) on delete cascade,
  name text not null,
  graph jsonb not null,
  saved_by text,
  created_at timestamptz not null default now()
);
create index if not exists workflow_versions_idx on workflow_versions (workflow_id, created_at desc);
