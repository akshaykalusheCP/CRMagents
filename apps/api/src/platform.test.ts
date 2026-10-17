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
