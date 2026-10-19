-- AI keys: several per workspace (any provider), one primary that everything uses, backups tried in order when the
-- primary fails (bad key, no credit, rate limits, provider down). Keys are encrypted; only a hint is ever shown.
create table if not exists ai_keys (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  label text not null,
  provider text not null check (provider in ('anthropic', 'openai', 'gemini', 'compatible')),
  key_enc text not null,
  key_hint text not null,
  base_url text,
  model text,
  fast_model text,
  price_in numeric,
  price_out numeric,
  workspace_id text,          -- Anthropic user keys (sk-ant-usr-…)
  is_primary boolean not null default false,
  is_backup boolean not null default false,
  sort int not null default 0,
  last_test_at timestamptz,
  last_test_ok boolean,
  last_test_ms int,
  last_test_model text,
  last_error text,
  last_error_at timestamptz,
  last_used_at timestamptz,
  created_by text,
  created_at timestamptz not null default now()
);
create unique index if not exists ai_keys_one_primary on ai_keys (account_id) where is_primary;
create index if not exists ai_keys_account on ai_keys (account_id, sort);
