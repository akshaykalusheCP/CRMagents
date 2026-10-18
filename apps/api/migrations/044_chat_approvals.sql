-- Approvals in Slack and Microsoft Teams: one connection of each kind per workspace, and the message posted for
-- each waiting run (so it can be updated when someone decides, wherever they decide).
create table if not exists approval_channels (
  account_id uuid not null references accounts(id) on delete cascade,
  kind text not null check (kind in ('slack', 'teams')),
  team_id text,
  team_name text,
  channel_id text,
  channel_name text,
  secret_enc text not null, -- Slack bot token, or the Teams webhook address
  connected_by text,
  created_at timestamptz not null default now(),
  primary key (account_id, kind)
);
create index if not exists approval_channels_team_idx on approval_channels (team_id) where kind = 'slack';

create table if not exists approval_messages (
  run_id uuid not null references runs(id) on delete cascade,
  kind text not null,
  channel text not null,
  ts text not null,
  created_at timestamptz not null default now(),
  primary key (run_id, kind)
);
