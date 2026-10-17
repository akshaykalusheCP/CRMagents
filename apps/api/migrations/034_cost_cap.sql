-- Price certainty: an optional monthly AI spending cap per agent.
alter table workflows add column if not exists monthly_cap_usd numeric;
