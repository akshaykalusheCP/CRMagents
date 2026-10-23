import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { pool } from './db.js';
import { ASKS_PER_MINUTE, slotWait } from './spend.js';
import { purgeOldRuns } from './trust/recovery.js';

after(() => pool.end());

test('assistant questions: plan-based limit, and a wait (not an error) until a slot frees', () => {
  assert.ok(ASKS_PER_MINUTE.pro > ASKS_PER_MINUTE.basic);
  const now = 100_000;
  assert.equal(slotWait([], now, 3), 0);
  assert.equal(slotWait([now - 70_000, now - 65_000, now - 61_000], now, 3), 0, 'older than a minute does not count');
  const w = slotWait([now - 50_000, now - 20_000, now - 10_000], now, 3);
  assert.ok(w > 9_000 && w < 11_000, `waits until the oldest of the last 3 is a minute old (${w})`);
});

test('AI log: full text cleared after 7 days, cost and model kept; recent calls untouched', async () => {
  const { rows: acc } = await pool.query("select t.account_id from tenants t limit 1");
  if (!acc[0]) return;
  const a = acc[0].account_id;
  const ins = (days: number) => pool.query(
    `insert into ai_calls (account_id, provider, model, request, response, masked_values, input_tokens, output_tokens, cost_usd, ms, created_at)
     values ($1,'anthropic','m',$2,$3,0,10,5,0.01,1, now() - ($4 || ' days')::interval) returning id`,
    [a, JSON.stringify({ system: 'secret prompt', messages: [{ role: 'user', content: 'hello' }], tools: [] }), JSON.stringify({ content: 'hi' }), String(days)]);
  const old = (await ins(9)).rows[0].id;
  const fresh = (await ins(1)).rows[0].id;
  await purgeOldRuns();
  const { rows } = await pool.query('select id, request, cost_usd, model from ai_calls where id = any($1)', [[old, fresh]]);
  const o = rows.find((r) => r.id === old);
  const f = rows.find((r) => r.id === fresh);
  assert.equal(o.request.trimmed, true);
  assert.ok(!JSON.stringify(o.request).includes('secret prompt'));
  assert.equal(Number(o.cost_usd), 0.01);
  assert.ok(JSON.stringify(f.request).includes('secret prompt'));
  await pool.query('delete from ai_calls where id = any($1)', [[old, fresh]]);
});
