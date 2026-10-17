import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pool } from '../db.js';
import { aiContext, maskedCount, readable, withAiLog } from './aiLog.js';

test('ai log: requests are stored readable and size-limited; files are not stored', () => {
  const r = readable([{ type: 'text', text: 'x'.repeat(9000) }, { type: 'tool_use', name: 'soql_query', input: { q: 'SELECT Id FROM Case' } }, { type: 'document', source: { media_type: 'application/pdf', data: 'AAAA' } }]) as any[];
  assert.match(r[0].text, /more characters\]$/);
  assert.equal(r[1].tool, 'soql_query');
  assert.ok(!JSON.stringify(r[2]).includes('AAAA'));
});

test('ai log: counts the personal values that were masked before sending', () => {
  assert.equal(maskedCount({ messages: [{ content: 'Call [PHONE_1] or mail [EMAIL_1]; again [EMAIL_1]. Salary [Salary__c_1]' }] }), 3);
  assert.equal(maskedCount('no placeholders [here]'), 0);
});

test('ai log: every call through the client is recorded with its context, and failures too', async () => {
  const { rows: acc } = await pool.query("insert into accounts (name) values ('ai-log-test') returning id");
  const fake = { messages: { create: async (p: any) => {
    if (p.model === 'boom') throw new Error('provider down');
    return { content: [{ type: 'text', text: 'Hi [EMAIL_1]' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 3 } };
  } } } as any;
  const c = withAiLog(fake, acc[0].id, 'anthropic', { purpose: 'Test' });
  await aiContext.run({ purpose: 'Inside a run' }, () => c.messages.create({ model: 'claude-haiku-5-5', max_tokens: 10, system: 'S', messages: [{ role: 'user', content: 'Mail [EMAIL_1]' }] } as any));
  await assert.rejects(c.messages.create({ model: 'boom', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] } as any));
  await new Promise((r) => setTimeout(r, 100));
  const { rows } = await pool.query('select purpose, masked_values, error, request from ai_calls where account_id=$1 order by id', [acc[0].id]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].purpose, 'Inside a run');
  assert.equal(rows[0].masked_values, 1);
  assert.equal(rows[0].request.messages[0].content, 'Mail [EMAIL_1]');
  assert.equal(rows[1].error, 'provider down');
  await pool.query('delete from accounts where id=$1', [acc[0].id]);
  await pool.end();
});
