create table if not exists settings (
  key text primary key,
  value_enc text not null,
  updated_at timestamptz not null default now()
);
