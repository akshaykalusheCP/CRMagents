-- Trust layer.
-- Every AI request exactly as sent (after masking) and its reply, so a workspace can see what the AI saw.
create table if not exists ai_calls (
  id bigserial primary key,
  account_id uuid not null references accounts(id) on delete cascade,
  tenant_id uuid references tenants(id) on delete set null,
  run_id uuid,
  purpose text,
  provider text not null,
  model text not null,
  request jsonb not null,
  response jsonb,
  masked_values int not null default 0,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cost_usd numeric not null default 0,
  ms int,
  error text,
  created_at timestamptz not null default now()
);
create index if not exists ai_calls_account_idx on ai_calls (account_id, created_at desc);
create index if not exists ai_calls_run_idx on ai_calls (run_id);

-- Who did what in the workspace (every change made through the app, sign-ins, exports).
create table if not exists audit_log (
  id bigserial primary key,
  account_id uuid not null references accounts(id) on delete cascade,
  user_email text,
  action text not null,
  target text,
  tenant_id uuid,
  ip text,
  created_at timestamptz not null default now()
);
create index if not exists audit_log_account_idx on audit_log (account_id, created_at desc);
