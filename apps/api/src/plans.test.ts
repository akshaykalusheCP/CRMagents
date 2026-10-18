import assert from 'node:assert/strict';
import { test } from 'node:test';
import { graphFeatures, PLAN_DEFS } from '@crmagents/shared';
import { pool } from './db.js';
import { accountPlan, endTrials, hasFeature, limitReached, planHas, requiredFeature, requireFeature, requireRoom } from './plans.js';

const T = '/api/tenants/7d8e5c1a-1111-4222-8333-944445555666';

test('plans: each page or action maps to its feature; deletes are always allowed', () => {
  assert.equal(requiredFeature('GET', `${T}/insights?period=30`), 'insights');
  assert.equal(requiredFeature('POST', `${T}/dashboards/run`), 'insights');
  assert.equal(requiredFeature('GET', `${T}/xray`), 'xray');
  assert.equal(requiredFeature('GET', `${T}/impact?days=30`), 'impact');
  assert.equal(requiredFeature('POST', `${T}/discover/case-triage/prove`), 'prove');
  assert.equal(requiredFeature('POST', `${T}/discover/scan`), null, 'the Discover scan is on every plan');
  assert.equal(requiredFeature('POST', '/api/knowledge'), 'knowledge');
  assert.equal(requiredFeature('GET', '/api/knowledge'), null);
  assert.equal(requiredFeature('DELETE', '/api/knowledge/abc'), null);
  assert.equal(requiredFeature('PUT', `${T}/workflows/abc/cap`), 'costCaps');
  assert.equal(requiredFeature('POST', `${T}/package`), 'panel');
  assert.equal(requiredFeature('GET', '/api/trust/ai-calls'), 'trustLog');
  assert.equal(requiredFeature('GET', '/api/trust'), null, 'the safeguards summary is on every plan');
  assert.equal(requiredFeature('POST', `${T}/undo`), null, 'safety is never limited by plan');
  assert.equal(requiredFeature('POST', `${T}/runs/abc/decision`), null);
});

test('plans: limits and features per plan; agents need the features their steps use', () => {
  assert.ok(limitReached('basic', 'orgs', 1));
  assert.ok(!limitReached('plus', 'orgs', 1));
  assert.ok(!limitReached('promax', 'orgs', 10_000));
  assert.ok(limitReached('basic', 'liveAgents', 3) && !limitReached('basic', 'liveAgents', 2));
  assert.ok(!planHas('basic', 'insights') && planHas('plus', 'insights') && !planHas('plus', 'xray') && planHas('pro', 'xray'));
  assert.deepEqual(PLAN_DEFS.pro.features, PLAN_DEFS.promax.features);
  assert.deepEqual(graphFeatures({ nodes: [{ type: 'sf.emailReply' }, { type: 'notify.sms' }, { type: 'sf.updateRecord' }] }).sort(), ['emailReplies', 'textMessages']);
});

test('plans: a Basic trial is held to its limits, ends on time, and an upgrade lifts it', async () => {
  const { rows: acc } = await pool.query("insert into accounts (name, plan, trial_ends_at) values ('plan-test', 'basic', now() + interval '14 days') returning id");
  const a = acc[0].id;
  const { rows: t } = await pool.query("insert into tenants (sf_org_id, sf_instance_url, refresh_token_enc, account_id) values ('00DPLANTEST0001','https://x.invalid','x',$1) returning id", [a]);
  await assert.rejects(requireRoom(a, 'orgs'), (e: Error & { statusCode?: number }) => e.statusCode === 402 && /includes 1 Salesforce org/.test(e.message));
  await assert.rejects(requireFeature(a, 'insights'), /part of the Plus plan/);
  for (let i = 0; i < 2; i++) await pool.query("insert into agents (tenant_id, name) values ($1, 'A')", [t[0].id]);
  await assert.rejects(requireRoom(a, 'assistants'), /includes 2 assistants/);
  // The trial ends: live agents pause, and nothing can start.
  await pool.query("insert into workflows (tenant_id, name, live) values ($1, 'W', true)", [t[0].id]);
  await pool.query("update accounts set trial_ends_at = now() - interval '1 minute' where id=$1", [a]);
  assert.equal((await accountPlan(a)).trialEnded, true);
  let alerted = 0;
  await endTrials(async (id) => { if (id === a) alerted++; });
  const { rows: w } = await pool.query('select live, paused_reason from workflows where tenant_id=$1', [t[0].id]);
  assert.equal(w[0].live, false);
  assert.match(w[0].paused_reason, /trial ended/);
  assert.equal(alerted, 1);
  await assert.rejects(requireRoom(a, 'liveAgents'), /trial has ended/);
  // Set to Pro by Nimbus: everything opens up again.
  await pool.query("update accounts set plan='pro', trial_ends_at=null where id=$1", [a]);
  assert.equal(await hasFeature(a, 'xray'), true);
  await requireRoom(a, 'orgs');
  await pool.query('delete from accounts where id=$1', [a]);
  await pool.end();
});
