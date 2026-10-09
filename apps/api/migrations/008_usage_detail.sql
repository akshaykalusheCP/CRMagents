-- Separate usage meters per run so caching and spend can be verified (input_tokens = uncached input only from now on).
alter table runs add column if not exists cache_read_tokens int not null default 0;
alter table runs add column if not exists cache_write_tokens int not null default 0;
alter table runs add column if not exists cost_usd numeric(12,6) not null default 0;
create index if not exists runs_tenant_created_idx on runs (tenant_id, created_at);
