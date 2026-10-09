-- Reuse AI answers for identical inputs (per workspace) so repeated runs on unchanged data cost nothing.
create table if not exists ai_result_cache (
  key text primary key,
  account_id uuid not null references accounts(id) on delete cascade,
  text text not null,
  created_at timestamptz not null default now()
);
create index if not exists ai_result_cache_created_idx on ai_result_cache (created_at);
