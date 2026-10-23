import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { pool } from '../db.js';
import { allowed, apiLevel, assertBudget, countCall, flushOwnUsage, ownUsage, recordUsage, setOwnCap } from './limits.js';

after(() => pool.end());

test("API cap: Nimbus's own calls are counted, saved, and it gives way against the cap an admin set", async () => {
  const { rows } = await pool.query('select id from tenants limit 1');
  if (!rows[0]) return;
  const t = rows[0].id as string;
  await pool.query('delete from api_calls_hourly where tenant_id=$1', [t]);
  await pool.query('update tenants set api_cap = 1000 where id=$1', [t]);
  recordUsage(t, 'api-usage=100/100000'); // the org as a whole is nearly idle
  countCall(t);
  await new Promise((r) => setTimeout(r, 200)); // first call loads the cap
  for (let i = 0; i < 849; i++) countCall(t);
  await flushOwnUsage();
  const { rows: saved } = await pool.query("select sum(calls)::int n from api_calls_hourly where tenant_id=$1", [t]);
  assert.equal(saved[0].n, 850);
  assert.equal(ownUsage(t)?.used24h, 850);
  assert.equal(apiLevel(t), 2, '85% of its own cap: optional work stops even though the org is idle');
  assert.ok(!allowed(apiLevel(t), 'background'));
  assert.ok(allowed(apiLevel(t), 'trigger'));
  assert.throws(() => assertBudget(t, 'background'), /limit set for Nimbus in this org: 850 of 1,000/);
  setOwnCap(t, null);
  assert.equal(apiLevel(t), 0, 'no cap: back to the org-wide level');
  await pool.query('update tenants set api_cap = null where id=$1', [t]);
  await pool.query('delete from api_calls_hourly where tenant_id=$1', [t]);
});
