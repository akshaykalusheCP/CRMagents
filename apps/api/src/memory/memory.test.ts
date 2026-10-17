import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pool } from '../db.js';
import { addMemory, addRecordNote, deleteMemory, listMemories, memoryPrompt, pickMemories, recordNotes, refuseMemory } from './store.js';
import { addMessages, conversationHistory, ensureConversation, getConversation, listConversations } from './conversations.js';

test('memory: personal data is refused; one short fact is fine', () => {
  assert.equal(refuseMemory('I manage the West region'), null);
  assert.match(refuseMemory('Customer email is ravi@acme.in') ?? '', /personal data/);
  assert.match(refuseMemory('Call me on +91 98450 12345') ?? '', /personal data/);
  assert.match(refuseMemory('x'.repeat(400)) ?? '', /under 300/);
  assert.match(refuseMemory('   ') ?? '', /Nothing/);
});

test('memory: all memories when few, the closest when many', () => {
  const few = [{ text: 'a' }, { text: 'b' }];
  assert.equal(pickMemories('anything', few).length, 2);
  const many = Array.from({ length: 40 }, (_, i) => ({ text: `filler fact number ${i}` }));
  many.push({ text: 'A hot deal is over 100k and closes this quarter' });
  const got = pickMemories('show my hot deals', many, 5);
  assert.equal(got[0].text, 'A hot deal is over 100k and closes this quarter');
  assert.equal(got.length, 5);
});

test('memory: personal stays with its owner, team is shared, duplicates are one; notes and chats are kept', async () => {
  const { rows: acc } = await pool.query("insert into accounts (name) values ('memory-test') returning id");
  const a = acc[0].id;
  const { rows: t } = await pool.query("insert into tenants (sf_org_id, sf_instance_url, refresh_token_enc, account_id) values ('00DMEMTEST00001','https://x.invalid','x',$1) returning id", [a]);
  const tenant = t[0].id;
  await addMemory(a, { scope: 'personal', owner: 'Ann@acme.test', text: 'I own the enterprise accounts', source: 'user', createdBy: 'ann@acme.test' });
  const dup = await addMemory(a, { scope: 'personal', owner: 'ann@acme.test', text: 'i own the enterprise accounts', source: 'assistant', createdBy: 'ann@acme.test' });
  assert.equal(dup.duplicate, true);
  await addMemory(a, { scope: 'team', text: 'We call Cases tickets', source: 'user', createdBy: 'ann@acme.test' });
  const ann = await listMemories(a, 'ann@acme.test');
  const bob = await listMemories(a, 'bob@acme.test');
  assert.equal(ann.length, 2);
  assert.deepEqual(bob.map((m) => m.text), ['We call Cases tickets']);
  // Bob can't remove Ann's memory, nor (without the role) the team's.
  await assert.rejects(deleteMemory(a, ann.find((m) => m.scope === 'personal')!.id, 'bob@acme.test', true));
  await assert.rejects(deleteMemory(a, ann.find((m) => m.scope === 'team')!.id, 'bob@acme.test', false));

  await addRecordNote(tenant, '500AAAAAAAAAAAAAAA', 'Customer prefers email', 'Case triage');
  await assert.rejects(addRecordNote(tenant, '500AAAAAAAAAAAAAAA', 'Their number is +1 415 555 0100', 'Case triage'));
  assert.equal((await recordNotes(tenant, '500AAAAAAAAAAAA')).length, 1);

  const p = await memoryPrompt(a, tenant, 'ann@acme.test', 'my tickets', '500AAAAAAAAAAAAAAA');
  assert.match(p.text, /We call Cases tickets/);
  assert.match(p.text, /I own the enterprise accounts/);
  assert.match(p.text, /Customer prefers email/);
  const team = await memoryPrompt(a, tenant, '', 'anything');
  assert.ok(!team.text.includes('enterprise accounts'), 'automations get team memory only');

  const conv = await ensureConversation({ accountId: a, tenantId: tenant, agentId: null, userKey: 'ann@acme.test', channel: 'app' }, null, 'How many open tickets?');
  await addMessages(conv, [{ role: 'user', text: 'How many open tickets?' }, { role: 'assistant', text: '12' }]);
  assert.deepEqual((await conversationHistory(conv)).map((m) => m.text), ['How many open tickets?', '12']);
  assert.equal((await listConversations(tenant, 'ann@acme.test'))[0].title, 'How many open tickets?');
  await assert.rejects(getConversation(tenant, 'bob@acme.test', conv), /not found/);
  // Someone else's conversation id starts a new conversation instead of joining it.
  assert.notEqual(await ensureConversation({ accountId: a, tenantId: tenant, agentId: null, userKey: 'bob@acme.test', channel: 'app' }, conv, 'hi'), conv);

  await pool.query('delete from accounts where id=$1', [a]);
  await pool.end();
});
