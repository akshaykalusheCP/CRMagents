-- Knowledge base: the company's own documents (support guides, policies), split into searchable chunks.
create table if not exists knowledge_docs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  title text not null,
  file_name text,
  kind text not null default 'text',
  chars int not null default 0,
  chunks int not null default 0,
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists knowledge_docs_account_idx on knowledge_docs (account_id);

create table if not exists knowledge_chunks (
  id bigserial primary key,
  doc_id uuid not null references knowledge_docs(id) on delete cascade,
  account_id uuid not null,
  seq int not null,
  heading text not null default '',
  body text not null,
  tsv tsvector generated always as (to_tsvector('english', heading || ' ' || body)) stored
);
create index if not exists knowledge_chunks_tsv_idx on knowledge_chunks using gin (tsv);
create index if not exists knowledge_chunks_account_idx on knowledge_chunks (account_id);

-- Suggestions an agent saved against a Salesforce record, shown on that record's page.
create table if not exists suggestions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  record_id text not null,
  object_name text not null default '',
  workflow_id uuid references workflows(id) on delete set null,
  run_id uuid references runs(id) on delete set null,
  title text not null default '',
  body text not null,
  sources jsonb not null default '[]',
  status text not null default 'new',
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists suggestions_record_idx on suggestions (tenant_id, record_id, created_at desc);
