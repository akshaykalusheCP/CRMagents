-- Wait step (runs sleep until a time) and per-agent field allow-lists.
alter table runs add column if not exists wake_at timestamptz;
create index if not exists runs_wake_idx on runs (wake_at) where status = 'sleeping';
alter table workflows add column if not exists allowed_fields jsonb not null default '{}';
