import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { pool } from '../db.js';
import { billingConfigured, createCheckout, formEncode, handleStripeEvent, planOfPrice, setStripeFetch, verifyStripeSignature } from './stripe.js';

Object.assign(process.env, {
  STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x',
  STRIPE_PRICE_PLUS_MONTHLY: 'price_plus_m', STRIPE_PRICE_PLUS_YEARLY: 'price_plus_y', STRIPE_PRICE_PRO_MONTHLY: 'price_pro_m', STRIPE_PRICE_PRO_YEARLY: 'price_pro_y',
});

test('billing: Stripe form encoding, prices and signatures', () => {
  assert.deepEqual(formEncode({ mode: 'subscription', line_items: [{ price: 'p1', quantity: 1 }], metadata: { a: 'b' } }),
    ['mode=subscription', 'line_items%5B0%5D%5Bprice%5D=p1', 'line_items%5B0%5D%5Bquantity%5D=1', 'metadata%5Ba%5D=b']);
  assert.ok(billingConfigured());
  assert.deepEqual(planOfPrice('price_pro_y'), { plan: 'pro', interval: 'year' });
  assert.equal(planOfPrice('price_unknown'), null);
  const payload = '{"id":"evt_1"}';
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', 'whsec_x').update(`${t}.${payload}`).digest('hex');
  assert.ok(verifyStripeSignature(payload, `t=${t},v1=${sig}`, 'whsec_x'));
  assert.ok(!verifyStripeSignature(payload + ' ', `t=${t},v1=${sig}`, 'whsec_x'), 'tampered body');
  assert.ok(!verifyStripeSignature(payload, `t=${t - 1000},v1=${sig}`, 'whsec_x'), 'too old');
  assert.ok(!verifyStripeSignature(payload, `t=${t},v1=${sig}`, 'other'), 'wrong secret');
});

test('billing: checkout, then webhooks set the plan, record who bought it, and a cancellation pauses', async () => {
  const { rows: acc } = await pool.query("insert into accounts (name, plan, trial_ends_at) values ('billing-test','basic', now() + interval '10 days') returning id");
  const a = acc[0].id;
  const calls: { url: string; body: string }[] = [];
  const sub = { id: 'sub_1', customer: 'cus_1', status: 'active', current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400, cancel_at_period_end: false, start_date: Math.floor(Date.now() / 1000),
    metadata: { accountId: a, plan: 'pro', by: 'buyer@acme.test' }, items: { data: [{ price: { id: 'price_pro_m', unit_amount: 19900, currency: 'usd', recurring: { interval: 'month' } } }] } };
  setStripeFetch((async (url: string, init?: RequestInit) => {
    calls.push({ url, body: String(init?.body ?? '') });
    const out = url.includes('/customers') ? { id: 'cus_1' } : url.includes('/checkout/sessions') ? { url: 'https://checkout.stripe.test/s1' } : url.includes('/subscriptions/') ? sub : {};
    return new Response(JSON.stringify(out), { status: 200 });
  }) as typeof fetch);

  const c = await createCheckout({ accountId: a, email: 'buyer@acme.test', accountName: 'Acme' }, 'pro', 'month');
  assert.equal(c.url, 'https://checkout.stripe.test/s1');
  assert.ok(calls.some((x) => x.url.includes('/checkout/sessions') && x.body.includes('price_pro_m')));

  await handleStripeEvent({ id: 'evt_a', type: 'checkout.session.completed', data: { object: { customer: 'cus_1', subscription: 'sub_1', client_reference_id: a, amount_total: 19900, currency: 'usd', metadata: { accountId: a, plan: 'pro', by: 'buyer@acme.test' } } } });
  const again = await handleStripeEvent({ id: 'evt_a', type: 'checkout.session.completed', data: { object: {} } });
  assert.equal(again.duplicate, true, 'each event applies once');
  let { rows } = await pool.query('select a.plan, s.status, s.purchased_by, s.amount_cents from accounts a join subscriptions s on s.account_id = a.id where a.id=$1', [a]);
  assert.deepEqual(rows[0], { plan: 'pro', status: 'active', purchased_by: 'buyer@acme.test', amount_cents: 19900 });

  await handleStripeEvent({ id: 'evt_b', type: 'invoice.payment_failed', data: { object: { customer: 'cus_1', amount_due: 19900, currency: 'usd' } } });
  await handleStripeEvent({ id: 'evt_c', type: 'customer.subscription.deleted', data: { object: { ...sub, status: 'canceled' } } });
  ({ rows } = await pool.query('select plan, trial_ends_at < now() as ended from accounts where id=$1', [a]));
  assert.equal(rows[0].plan, 'basic');
  assert.equal(rows[0].ended, true, 'a cancelled subscription leaves no trial: agents pause');
  const { rows: hist } = await pool.query('select to_plan, changed_by from plan_history where account_id=$1 order by id', [a]);
  assert.deepEqual(hist.map((h) => `${h.to_plan}:${h.changed_by}`), ['pro:stripe', 'basic:stripe']);
  const { rows: ev } = await pool.query('select type from billing_events where account_id=$1 order by id', [a]);
  assert.deepEqual(ev.map((e) => e.type), ['subscription_started', 'payment_failed', 'subscription_canceled']);
  await pool.query("delete from billing_events where stripe_event_id in ('evt_a','evt_b','evt_c')");
  await pool.query('delete from accounts where id=$1', [a]);
});

test('deleting a workspace cancels its paid subscription first, and keeps everything if Stripe refuses', async () => {
  const { deleteWorkspace } = await import('../trust/audit.js');
  const key = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  const make = async (sub: string) => {
    const { rows } = await pool.query("insert into accounts (name, plan) values ('delete-test','pro') returning id");
    await pool.query("insert into subscriptions (account_id, stripe_customer_id, stripe_subscription_id, plan, status) values ($1,'cus_d',$2,'pro','active')", [rows[0].id, sub]);
    return rows[0].id as string;
  };
  const exists = async (id: string) => (await pool.query('select 1 from accounts where id=$1', [id])).rowCount === 1;
  try {
    const calls: string[] = [];
    setStripeFetch((async (url: string, init?: RequestInit) => { calls.push(`${init?.method} ${url}`); return new Response(JSON.stringify({ id: 'sub_d1', status: 'canceled' }), { status: 200 }); }) as typeof fetch);
    const a = await make('sub_d1');
    await deleteWorkspace(a);
    assert.ok(calls.includes('DELETE https://api.stripe.com/v1/subscriptions/sub_d1'), calls.join(', '));
    assert.equal(await exists(a), false);

    setStripeFetch((async () => new Response(JSON.stringify({ error: { message: 'Stripe is down' } }), { status: 500 })) as typeof fetch);
    const b = await make('sub_d2');
    await assert.rejects(deleteWorkspace(b), /Stripe is down/);
    assert.equal(await exists(b), true, 'nothing deleted while the customer could still be charged');
    await pool.query('delete from accounts where id=$1', [b]);
  } finally {
    if (key === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = key;
    await pool.end();
  }
});
