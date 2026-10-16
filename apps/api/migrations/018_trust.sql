-- Reliability and retention: runs report they are alive while working, and old run details get cleared.
alter table runs add column if not exists heartbeat_at timestamptz;
alter table runs add column if not exists purged_at timestamptz;
alter table runs add column if not exists decided_by text;
create index if not exists runs_status_idx on runs (status) where status in ('running', 'stopped', 'waiting');
