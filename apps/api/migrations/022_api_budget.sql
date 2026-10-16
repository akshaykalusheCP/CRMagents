-- Salesforce API allowance per org (from the Sforce-Limit-Info header) and adaptive record checks.
alter table tenants add column if not exists api_used int;
alter table tenants add column if not exists api_max int;
alter table tenants add column if not exists api_checked_at timestamptz;
-- Record checks: how many in a row found nothing (slows checks down), and when the next one is due.
alter table workflows add column if not exists poll_idle int not null default 0;
alter table workflows add column if not exists poll_next_at timestamptz;
