-- Per-org shared secret used to sign requests coming from the CRMagents package inside Salesforce.
alter table tenants add column if not exists sf_signing_secret_enc text;
