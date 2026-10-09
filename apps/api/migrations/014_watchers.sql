-- Server-side triggers (no Salesforce package): a live workflow is checked every minute for new/changed records.
alter table workflows add column if not exists live boolean not null default false;
alter table workflows add column if not exists live_since timestamptz;
alter table workflows add column if not exists watch_cursor timestamptz;
alter table workflows add column if not exists watch_seen jsonb not null default '[]';
alter table workflows add column if not exists watch_error text;
-- The Salesforce package (record-page panel) is optional now.
alter table tenants add column if not exists use_package boolean not null default false;
