import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PlanId } from '@crmagents/shared';
import { config } from '../config.js';
import { pool } from '../db.js';
import { changePlan } from '../plans.js';
import { raiseAlert } from '../alerts.js';

// Online payment with Stripe: Checkout to subscribe to Plus or Pro (monthly or yearly), the Customer Portal to
// change card, plan or cancel, and webhooks that keep the workspace's plan in step with its subscription.
// Off until the keys are set (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and the four price ids); until then the
// app asks staff for upgrades instead. Talks to the Stripe API directly (no SDK).

export type Interval = 'month' | 'year';
type Paid = 'plus' | 'pro';

const env = (k: string) => process.env[k]?.trim() || '';
const PRICE_ENV: Record<Paid, Record<Interval, string>> = {
  plus: { month: 'STRIPE_PRICE_PLUS_MONTHLY', year: 'STRIPE_PRICE_PLUS_YEARLY' },
  pro: { month: 'STRIPE_PRICE_PRO_MONTHLY', year: 'STRIPE_PRICE_PRO_YEARLY' },
};
export const priceId = (plan: Paid, interval: Interval) => env(PRICE_ENV[plan][interval]);

/** Which plan a Stripe price is (from the configured price ids). */
export function planOfPrice(id: string): { plan: Paid; interval: Interval } | null {
  for (const plan of ['plus', 'pro'] as Paid[]) for (const interval of ['month', 'year'] as Interval[]) if (id && priceId(plan, interval) === id) return { plan, interval };
  return null;
}

export function billingConfigured() {
  return !!env('STRIPE_SECRET_KEY') && !!env('STRIPE_WEBHOOK_SECRET') && (['plus', 'pro'] as Paid[]).every((p) => priceId(p, 'month'));
}

/** Stripe's form encoding, with nested keys (line_items[0][price]=...). Pure; tested. */
export function formEncode(o: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (typeof x === 'object' ? out.push(...formEncode(x as Record<string, unknown>, `${key}[${i}]`)) : out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(x))}`)));
    else if (typeof v === 'object') out.push(...formEncode(v as Record<string, unknown>, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out;
}

let fetchImpl: typeof fetch = fetch;
export const setStripeFetch = (f: typeof fetch) => { fetchImpl = f; };

async function stripe<T = any>(method: 'GET' | 'POST', path: string, params: Record<string, unknown> = {}): Promise<T> {
  const body = formEncode(params).join('&');
  const res = await fetchImpl(`https://api.stripe.com/v1${path}${method === 'GET' && body ? `?${body}` : ''}`, {
    method,
    headers: { Authorization: `Bearer ${env('STRIPE_SECRET_KEY')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: method === 'POST' ? body : undefined,
  });
  const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  if (!res.ok) throw Object.assign(new Error(`Payment provider: ${j.error?.message ?? res.status}`), { statusCode: 502 });
  return j as T;
}

async function customerFor(accountId: string, email: string, name: string) {
  const { rows } = await pool.query('select stripe_customer_id from subscriptions where account_id=$1', [accountId]);
  if (rows[0]?.stripe_customer_id) return rows[0].stripe_customer_id as string;
  const c = await stripe<{ id: string }>('POST', '/customers', { email, name, metadata: { accountId } });
  await pool.query(`insert into subscriptions (account_id, stripe_customer_id) values ($1,$2)
    on conflict (account_id) do update set stripe_customer_id=$2, updated_at=now()`, [accountId, c.id]);
  return c.id;
}

const web = () => config.webUrl.replace(/\/$/, '');

/** A Checkout page for subscribing this workspace to a plan. */
export async function createCheckout(a: { accountId: string; email: string; accountName: string }, plan: Paid, interval: Interval) {
  if (!billingConfigured()) throw Object.assign(new Error('Online payment is not set up yet.'), { statusCode: 409, notConfigured: true });
  const price = priceId(plan, interval);
  if (!price) throw Object.assign(new Error(`The ${interval === 'year' ? 'yearly' : 'monthly'} price for ${plan} is not set up yet.`), { statusCode: 409 });
  const customer = await customerFor(a.accountId, a.email, a.accountName);
  const s = await stripe<{ url: string }>('POST', '/checkout/sessions', {
    mode: 'subscription', customer, client_reference_id: a.accountId,
    line_items: [{ price, quantity: 1 }],
    allow_promotion_codes: true,
    success_url: `${web()}/?tab=settings&billing=success`,
    cancel_url: `${web()}/?tab=settings&billing=cancelled`,
    metadata: { accountId: a.accountId, plan, by: a.email },
    subscription_data: { metadata: { accountId: a.accountId, plan, by: a.email } },
  });
  return { url: s.url };
}

/** Stripe's billing page for this workspace: card, invoices, change plan, cancel. */
export async function createPortal(accountId: string) {
  if (!billingConfigured()) throw Object.assign(new Error('Online payment is not set up yet.'), { statusCode: 409 });
  const { rows } = await pool.query('select stripe_customer_id from subscriptions where account_id=$1', [accountId]);
  if (!rows[0]?.stripe_customer_id) throw Object.assign(new Error('This workspace has no subscription yet.'), { statusCode: 400 });
  const s = await stripe<{ url: string }>('POST', '/billing_portal/sessions', { customer: rows[0].stripe_customer_id, return_url: `${web()}/?tab=settings` });
  return { url: s.url };
}

export async function billingStatus(accountId: string) {
  const { rows } = await pool.query(
    `select plan, interval, status, amount_cents as "amountCents", currency, current_period_end as "renewsAt", cancel_at_period_end as "cancelAtPeriodEnd",
            purchased_by as "purchasedBy", started_at as "startedAt", stripe_subscription_id is not null as "hasSubscription"
     from subscriptions where account_id=$1`, [accountId]);
  const sub = rows[0]?.hasSubscription ? rows[0] : null;
  return {
    configured: billingConfigured(),
    intervals: { plus: { month: !!priceId('plus', 'month'), year: !!priceId('plus', 'year') }, pro: { month: !!priceId('pro', 'month'), year: !!priceId('pro', 'year') } },
    subscription: sub,
  };
}

/** Stripe-Signature check: t=<time>,v1=<HMAC-SHA256 of "t.payload">, within 5 minutes. Pure; tested. */
export function verifyStripeSignature(payload: string, header: string, secret: string, now = Date.now(), toleranceSec = 300): boolean {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]).filter((p) => p.length === 2)) as Record<string, string>;
  const sigs = header.split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length || Math.abs(now / 1000 - t) > toleranceSec) return false;
  const want = Buffer.from(createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex'));
  return sigs.some((s) => { const got = Buffer.from(s); return got.length === want.length && timingSafeEqual(got, want); });
}

interface StripeEvent { id: string; type: string; data: { object: any } }

async function accountOfCustomer(customer: string, metaAccount?: string): Promise<string | null> {
  if (metaAccount) return metaAccount;
  const { rows } = await pool.query('select account_id from subscriptions where stripe_customer_id=$1', [customer]);
  return rows[0]?.account_id ?? null;
}

async function logEvent(e: StripeEvent, accountId: string | null, type: string, f: { plan?: string; amount?: number; currency?: string; url?: string; detail?: string } = {}) {
  await pool.query(
    'insert into billing_events (account_id, stripe_event_id, type, plan, amount_cents, currency, invoice_url, detail) values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (stripe_event_id) do nothing',
    [accountId, e.id, type, f.plan ?? null, f.amount ?? null, f.currency ?? null, f.url ?? null, f.detail ?? null]);
}

/** A subscription's state applied to the workspace: its plan while active, Basic (paused) once it has ended. */
async function applySubscription(accountId: string, sub: any, by?: string) {
  const item = sub.items?.data?.[0];
  const p = planOfPrice(item?.price?.id ?? '') ?? (sub.metadata?.plan ? { plan: sub.metadata.plan as Paid, interval: (item?.price?.recurring?.interval ?? 'month') as Interval } : null);
  await pool.query(
    `insert into subscriptions (account_id, stripe_customer_id, stripe_subscription_id, plan, interval, status, amount_cents, currency, current_period_end, cancel_at_period_end, purchased_by, started_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
     on conflict (account_id) do update set stripe_customer_id=excluded.stripe_customer_id, stripe_subscription_id=excluded.stripe_subscription_id, plan=excluded.plan,
       interval=excluded.interval, status=excluded.status, amount_cents=excluded.amount_cents, currency=excluded.currency, current_period_end=excluded.current_period_end,
       cancel_at_period_end=excluded.cancel_at_period_end, purchased_by=coalesce(subscriptions.purchased_by, excluded.purchased_by),
       started_at=coalesce(subscriptions.started_at, excluded.started_at), updated_at=now()`,
    [accountId, sub.customer, sub.id, p?.plan ?? null, p?.interval ?? null, sub.status, item?.price?.unit_amount ?? null, item?.price?.currency ?? null,
      sub.current_period_end ? new Date(sub.current_period_end * 1000) : null, !!sub.cancel_at_period_end, by ?? sub.metadata?.by ?? null,
      sub.start_date ? new Date(sub.start_date * 1000) : new Date()]);
  const { rows } = await pool.query('select plan from accounts where id=$1', [accountId]);
  const live = ['active', 'trialing', 'past_due'].includes(sub.status);
  if (live && p && rows[0]?.plan !== p.plan) await changePlan(accountId, p.plan as PlanId, 'stripe', `Subscription ${sub.status}`);
  if (!live && ['canceled', 'unpaid', 'incomplete_expired'].includes(sub.status) && rows[0]?.plan !== 'basic') {
    // Ended: back to Basic with the trial over, so live agents pause (nothing is deleted).
    await changePlan(accountId, 'basic', 'stripe', `Subscription ${sub.status}`, { trialDays: 0 });
  }
  return p;
}

/** Apply one webhook event. Each event is applied once (Stripe may send it again). */
export async function handleStripeEvent(e: StripeEvent) {
  const { rows: seen } = await pool.query('select 1 from billing_events where stripe_event_id=$1', [e.id]);
  if (seen.length) return { duplicate: true };
  const o = e.data.object;
  switch (e.type) {
    case 'checkout.session.completed': {
      const accountId = await accountOfCustomer(o.customer, o.client_reference_id ?? o.metadata?.accountId);
      if (!accountId || !o.subscription) break;
      const sub = await stripe('GET', `/subscriptions/${o.subscription}`);
      const p = await applySubscription(accountId, sub, o.metadata?.by);
      await logEvent(e, accountId, 'subscription_started', { plan: p?.plan, amount: o.amount_total, currency: o.currency, detail: `Bought by ${o.metadata?.by ?? o.customer_details?.email ?? 'unknown'}` });
      return { ok: true };
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const accountId = await accountOfCustomer(o.customer, o.metadata?.accountId);
      if (!accountId) break;
      const p = await applySubscription(accountId, e.type === 'customer.subscription.deleted' ? { ...o, status: 'canceled' } : o);
      await logEvent(e, accountId, e.type === 'customer.subscription.deleted' ? 'subscription_canceled' : 'subscription_changed', { plan: p?.plan, detail: `Status ${o.status}${o.cancel_at_period_end ? ', cancels at period end' : ''}` });
      return { ok: true };
    }
    case 'invoice.paid':
    case 'invoice.payment_succeeded':
    case 'invoice.payment_failed': {
      const accountId = await accountOfCustomer(o.customer, o.subscription_details?.metadata?.accountId);
      const failed = e.type === 'invoice.payment_failed';
      await logEvent(e, accountId, failed ? 'payment_failed' : 'payment_succeeded', { amount: failed ? o.amount_due : o.amount_paid, currency: o.currency, url: o.hosted_invoice_url });
      if (failed && accountId) {
        await raiseAlert({ accountId, kind: 'billing', title: 'Payment failed', body: 'Your latest payment for CRMagents did not go through. Update your card in Settings → Plan → Manage billing to keep your plan.' });
      }
      return { ok: true };
    }
    case 'charge.refunded': {
      const accountId = await accountOfCustomer(o.customer);
      await logEvent(e, accountId, 'refund', { amount: o.amount_refunded, currency: o.currency });
      return { ok: true };
    }
  }
  await logEvent(e, null, `ignored:${e.type}`);
  return { ignored: true };
}
