-- Memory for assistants and agents.
-- Saved conversations: every chat with an assistant (in the app or the Salesforce panel), per person.
create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  agent_id uuid references agents(id) on delete cascade,
  user_key text not null,            -- the person's email, lowercased (same person in the app and Salesforce)
  channel text not null,             -- 'app' | 'salesforce'
  record_id text,                    -- a chat about one record stays with it
  title text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists conversations_user_idx on conversations (tenant_id, user_key, updated_at desc);
create index if not exists conversations_record_idx on conversations (tenant_id, left(record_id, 15), user_key, updated_at desc);
create table if not exists conversation_messages (
  id bigserial primary key,
  conversation_id uuid not null references conversations(id) on delete cascade,
  role text not null,
  text text not null,
  run_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists conversation_messages_idx on conversation_messages (conversation_id, id);

-- Long-term memory: what assistants know about a person (personal) or about how the team works (team).
create table if not exists memories (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  scope text not null,               -- 'personal' | 'team'
  owner text,                        -- the person's email for personal memories
  text text not null,
  source text not null default 'user',  -- 'user' (typed on the Memory page) | 'assistant' (saved in a chat)
  created_by text,
  uses int not null default 0,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists memories_account_idx on memories (account_id, scope, owner);

-- Record memory: short notes agents keep on a Salesforce record across runs and chats.
create table if not exists record_notes (
  id bigserial primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  record_id text not null,
  note text not null,
  author text,                       -- the agent or assistant that wrote it
  run_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists record_notes_idx on record_notes (tenant_id, left(record_id, 15), created_at desc);
