-- Which Nimbus package an org has: '' = the original package (no namespace), otherwise its namespace (e.g. 'nimbus').
-- Names of our objects, fields and actions in that org carry this prefix.
alter table tenants add column if not exists pkg_ns text not null default '';
