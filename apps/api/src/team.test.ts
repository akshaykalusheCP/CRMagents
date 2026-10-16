import assert from 'node:assert/strict';
import { test } from 'node:test';
import { roleAtLeast } from '@crmagents/shared';
import { requiredRole } from './roles.js';
import { failStreak, failureAction } from './alerts.js';
import { overLimit, clearLimit } from './ratelimit.js';
import { pool } from './db.js';

const T = '/api/tenants/7d8e5c1a-1111-4222-8333-944445555666';

test('roles: reading is open, changes need the right role', () => {
  assert.equal(requiredRole('GET', `${T}/workflows`), 'approver');
  assert.equal(requiredRole('GET', '/api/settings'), 'approver');
  assert.equal(requiredRole('PUT', '/api/settings'), 'admin');
  assert.equal(requiredRole('POST', '/api/team/invites'), 'admin');
  assert.equal(requiredRole('DELETE', T), 'admin');
  assert.equal(requiredRole('POST', `${T}/provision`), 'admin');
  assert.equal(requiredRole('POST', `${T}/workflows/abc/autonomy`), 'admin');
  assert.equal(requiredRole('PUT', `${T}/agents/abc/public`), 'admin');
  assert.equal(requiredRole('POST', `${T}/workflows`), 'builder');
  assert.equal(requiredRole('POST', `${T}/workflows/abc/live`), 'builder');
  assert.equal(requiredRole('POST', `${T}/runs/abc/decision`), 'approver');
  assert.equal(requiredRole('POST', `${T}/agents/abc/run`), 'approver');
  assert.equal(requiredRole('POST', '/api/auth/password'), 'approver');
  assert.equal(requiredRole('POST', '/api/alerts/read'), 'approver');
  // An unknown new route defaults to builder, never open to approvers.
  assert.equal(requiredRole('POST', `${T}/something-new`), 'builder');
  assert.ok(roleAtLeast('owner', 'admin') && roleAtLeast('admin', 'builder') && !roleAtLeast('approver', 'builder') && !roleAtLeast(undefined, 'approver'));
});

test('alerts: warn after 3 failures in a row, pause after the setting, successes reset the streak', () => {
  assert.equal(failStreak(['error', 'error', 'done', 'error']), 2);
  assert.equal(failStreak(['error', 'error', 'error']), 3);
  assert.equal(failureAction(2, 5), null);
  assert.equal(failureAction(3, 5), 'warn');
  assert.equal(failureAction(4, 5), null);
  assert.equal(failureAction(5, 5), 'pause');
  assert.equal(failureAction(5, 0), null); // 0 = never pause
  assert.equal(failureAction(20, 0), 'warn');
});

test('rate limits are shared through Postgres and reset per window', async () => {
  const key = `test|${Date.now()}`;
  assert.equal(await overLimit(key, 2, 60), false);
  assert.equal(await overLimit(key, 2, 60), false);
  assert.equal(await overLimit(key, 2, 60), true);
  await clearLimit(key);
  assert.equal(await overLimit(key, 2, 60), false);
  await clearLimit(key);
  await pool.end();
});
