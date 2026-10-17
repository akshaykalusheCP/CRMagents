-- Plans. Every workspace that exists before plans keeps everything (Pro Max); new sign-ups start a Basic trial.
alter table accounts add column if not exists plan text;
alter table accounts add column if not exists trial_ends_at timestamptz;
alter table accounts add column if not exists trial_ended_at timestamptz;
alter table accounts add column if not exists requested_plan text;
alter table accounts add column if not exists plan_set_by text;
alter table accounts add column if not exists plan_updated_at timestamptz;
update accounts set plan = 'promax', plan_set_by = 'existing workspace', plan_updated_at = now() where plan is null;
alter table accounts alter column plan set default 'basic';
alter table accounts alter column plan set not null;
