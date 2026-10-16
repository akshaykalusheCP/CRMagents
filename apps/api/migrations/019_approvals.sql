-- Approval routing and separation of duties.
alter table runs add column if not exists started_by text;
alter table runs add column if not exists assigned_to text;
alter table runs add column if not exists assigned_label text;
