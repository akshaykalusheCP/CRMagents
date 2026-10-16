-- Knowledge from Salesforce itself: Knowledge articles and Files libraries, kept in sync daily.
alter table knowledge_docs add column if not exists source text not null default 'upload';
alter table knowledge_docs add column if not exists source_ref text;
alter table knowledge_docs add column if not exists tenant_id uuid references tenants(id) on delete cascade;
create index if not exists knowledge_docs_source_idx on knowledge_docs (account_id, source, source_ref);
create table if not exists knowledge_sources (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  kind text not null,              -- 'articles' | 'library'
  library text,                    -- Files library name (kind = library)
  last_synced_at timestamptz,
  last_result text,
  created_at timestamptz not null default now(),
  unique (tenant_id, kind, library)
);
-- Agent changes recorded in Salesforce (CRMagents_Agent_Activity__c) are written once per run.
alter table runs add column if not exists audited boolean not null default false;
