-- Automatic org setup after connect: package install, remote site, settings, permission set.
alter table tenants add column if not exists sf_user_id text;
alter table tenants add column if not exists setup_status text not null default 'pending';
alter table tenants add column if not exists setup_message text;
