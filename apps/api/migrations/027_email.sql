-- Email replies suggested on a case: what kind of suggestion it is, and where the reply goes.
alter table suggestions add column if not exists kind text not null default 'note';
alter table suggestions add column if not exists meta jsonb not null default '{}';
