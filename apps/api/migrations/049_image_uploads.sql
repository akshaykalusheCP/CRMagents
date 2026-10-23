-- Images attached in the Salesforce panel, uploaded just before the question that uses them (kept separate so the
-- question stays small for Apex). Used once, and removed after 15 minutes either way.
create table if not exists image_uploads (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  images jsonb not null,
  created_at timestamptz not null default now()
);
