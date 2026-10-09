-- The Salesforce Flow that runs this workflow automatically (one-click "Add to Salesforce").
alter table workflows add column if not exists sf_flow_name text;
alter table workflows add column if not exists sf_deployed_at timestamptz;
