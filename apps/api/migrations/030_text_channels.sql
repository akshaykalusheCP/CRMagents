-- Text messages (SMS, WhatsApp through Twilio): an assistant can answer customers who text the company's number.
alter table agents add column if not exists sms_enabled boolean not null default false;

create table if not exists channel_messages (
  id bigserial primary key,
  agent_id uuid not null references agents(id) on delete cascade,
  channel text not null,          -- 'sms' | 'whatsapp'
  address text not null,          -- the customer's number, e.g. +14155550100
  role text not null,             -- 'user' | 'assistant'
  text text not null,
  created_at timestamptz not null default now()
);
create index if not exists channel_messages_conv_idx on channel_messages (agent_id, address, created_at desc);
