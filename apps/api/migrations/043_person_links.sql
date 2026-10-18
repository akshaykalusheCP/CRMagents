-- Each person's own Salesforce login (same org as the workspace's connection), so assistants in the app can act
-- as them: Salesforce then enforces their sharing, field security and object permissions.
create table if not exists person_sf_links (
  user_id uuid not null references users(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  sf_user_id text not null,
  sf_username text,
  refresh_token_enc text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, tenant_id)
);
