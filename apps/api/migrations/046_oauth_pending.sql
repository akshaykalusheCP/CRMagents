-- Salesforce logins in progress (PKCE verifier etc.), so a restart or a second server between "Connect" and the
-- callback doesn't lose them. Encrypted: it can hold a customer's own app secret. Rows live 30 minutes.
create table if not exists oauth_pending (
  state text primary key,
  data_enc text not null,
  created_at timestamptz not null default now()
);
