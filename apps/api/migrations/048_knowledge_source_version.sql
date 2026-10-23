-- Which version of a Salesforce article/file a synced document came from, so a sync only re-reads what changed.
alter table knowledge_docs add column if not exists source_version text;
