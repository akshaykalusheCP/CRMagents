-- Billing (Stripe) and the super-admin console.
create table if not exists subscriptions (
  account_id uuid primary key references accounts(id) on delete cascade,
  stripe_customer_id text,
  stripe_subscription_id text unique,
  plan text,
  interval text,                 -- 'month' | 'year'
  status text,                   -- Stripe: active, trialing, past_due, canceled, unpaid, incomplete
  amount_cents int,
  currency text,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  purchased_by text,             -- who started the checkout
  started_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists subscriptions_customer_idx on subscriptions (stripe_customer_id);

create table if not exists billing_events (
  id bigserial primary key,
  account_id uuid references accounts(id) on delete set null,
  stripe_event_id text unique,
  type text not null,            -- payment_succeeded, payment_failed, subscription_started, subscription_changed, subscription_canceled, refund
  plan text,
  amount_cents int,
  currency text,
  invoice_url text,
  detail text,
  created_at timestamptz not null default now()
);
create index if not exists billing_events_account_idx on billing_events (account_id, created_at desc);

create table if not exists plan_history (
  id bigserial primary key,
  account_id uuid not null references accounts(id) on delete cascade,
  from_plan text,
  to_plan text not null,
  changed_by text not null,      -- staff email, 'stripe', 'sign-up', 'trial ended'
  reason text,
  created_at timestamptz not null default now()
);
create index if not exists plan_history_account_idx on plan_history (account_id, created_at desc);

-- Requests from the pricing page, the Contact page and in-app upgrade asks, worked by staff.
alter table sales_inquiries add column if not exists topic text not null default 'sales';
alter table sales_inquiries add column if not exists source text not null default 'pricing';
alter table sales_inquiries add column if not exists status text not null default 'new';
alter table sales_inquiries add column if not exists notes text;
alter table sales_inquiries add column if not exists handled_by text;
alter table sales_inquiries add column if not exists account_id uuid references accounts(id) on delete set null;
alter table sales_inquiries add column if not exists updated_at timestamptz;
update sales_inquiries set source='upgrade', topic='upgrade' where message like 'Upgrade request:%' and source='pricing';
