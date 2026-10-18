import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clientHealth, clientStage } from './platform.js';

test('staff console: client stage from plan, trial and subscription', () => {
  const now = Date.parse('2026-10-18T00:00:00Z');
  const future = '2026-10-25T00:00:00Z', past = '2026-10-01T00:00:00Z';
  assert.equal(clientStage({ plan: 'basic', trialEndsAt: future, subStatus: null }, now), 'trial');
  assert.equal(clientStage({ plan: 'basic', trialEndsAt: past, subStatus: null }, now), 'expired');
  assert.equal(clientStage({ plan: 'pro', trialEndsAt: null, subStatus: 'active' }, now), 'paying');
  assert.equal(clientStage({ plan: 'plus', trialEndsAt: null, subStatus: 'past_due' }, now), 'past_due');
  assert.equal(clientStage({ plan: 'basic', trialEndsAt: past, subStatus: 'canceled' }, now), 'churned');
  assert.equal(clientStage({ plan: 'promax', trialEndsAt: null, subStatus: null }, now), 'comped');
});

test('staff console: health from last activity and org problems', () => {
  const now = Date.parse('2026-10-18T00:00:00Z');
  assert.equal(clientHealth('2026-10-15T00:00:00Z', false, now), 'active');
  assert.equal(clientHealth('2026-10-08T00:00:00Z', false, now), 'quiet');
  assert.equal(clientHealth('2026-09-20T00:00:00Z', false, now), 'at_risk');
  assert.equal(clientHealth('2026-10-17T00:00:00Z', true, now), 'at_risk', 'a disconnected org is a risk');
  assert.equal(clientHealth(null, false, now), 'at_risk');
});

test('staff console: every /api/platform route answers 404 to anyone who is not staff', async () => {
  const { default: Fastify } = await import('fastify');
  const { registerPlatform } = await import('./platform.js');
  const app = Fastify();
  const routes: { method: string; url: string }[] = [];
  app.addHook('onRoute', (r) => { for (const m of [r.method].flat()) if (m !== 'HEAD') routes.push({ method: m, url: r.url }); });
  // Signed in as a customer (not in PLATFORM_ADMINS), or not signed in at all.
  app.addHook('onRequest', async (req) => {
    const who = req.headers['x-test-user'];
    (req as { user?: unknown }).user = who ? { id: 'u1', email: String(who), role: 'owner', accountId: 'a1', accountName: 'Customer' } : undefined;
  });
  const before = process.env.PLATFORM_ADMINS;
  process.env.PLATFORM_ADMINS = 'staff@crmagents.example';
  try {
    registerPlatform(app);
    await app.ready();
    assert.ok(routes.length >= 15, `expected the staff routes, saw ${routes.length}`);
    // The guard isn't simply closed for everyone: staff get through (this route needs no database).
    const staff = await app.inject({ method: 'GET', url: '/api/platform/staff', headers: { 'x-test-user': 'Staff@CRMagents.example' } });
    assert.equal(staff.statusCode, 200);
    assert.deepEqual(staff.json(), ['staff@crmagents.example']);
    for (const r of routes) {
      const url = r.url.replace(/:[a-z]+/gi, '00000000-0000-0000-0000-000000000000');
      for (const who of ['owner@customer.example', 'STAFF@crmagents.example.evil', undefined]) {
        const res = await app.inject({ method: r.method as 'GET', url, headers: who ? { 'x-test-user': who } : {}, payload: r.method === 'GET' || r.method === 'DELETE' ? undefined : {} });
        assert.equal(res.statusCode, 404, `${r.method} ${r.url} as ${who ?? 'nobody'} gave ${res.statusCode}`);
      }
    }
  } finally {
    process.env.PLATFORM_ADMINS = before;
    await app.close();
  }
});
