-- Per-org Salesforce app (bring your own External Client App). Null = use the account/platform app.
alter table tenants add column if not exists sf_client_id text;
alter table tenants add column if not exists sf_client_secret_enc text;
