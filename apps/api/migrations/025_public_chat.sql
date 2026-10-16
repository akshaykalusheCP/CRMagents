-- Website chat: an assistant can answer the public on the customer's own website (or Experience Cloud site).
alter table agents add column if not exists public_key text unique;
alter table agents add column if not exists public_enabled boolean not null default false;
alter table agents add column if not exists public_origins text not null default '';
alter table agents add column if not exists public_cases boolean not null default true;
alter table agents add column if not exists public_greeting text not null default '';
