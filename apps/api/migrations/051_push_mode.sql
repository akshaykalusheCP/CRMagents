-- How a "Push from Salesforce" agent hears about saved records: 'events' (its Flow publishes a Nimbus Record Change
-- event that Nimbus listens for; kept 3 days by Salesforce) or 'callout' (older packages: the Flow calls Nimbus).
alter table workflows add column if not exists push_mode text;
