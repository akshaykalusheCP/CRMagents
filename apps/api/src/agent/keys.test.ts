import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pool } from '../db.js';
import { setSetting } from '../settings.js';
import { activeKeys, adoptLegacyKeys, canFailOver, explainError, inOrder, keyHint } from './keys.js';

test('key hints show the kind of key and its last 4, never the secret', () => {
  assert.equal(keyHint('sk-ant-api03-abcdefghijklmnopqrstuvwxyzA9F2'), 'sk-ant-api03-…A9F2');
  assert.equal(keyHint('sk-proj-1234567890abcdefXYZ1'), 'sk-proj-…XYZ1');
  assert.equal(keyHint('AIzaSyD-1234567890abcdQ7'), 'AIza…cdQ7');
  assert.equal(keyHint('short'), '••••');
  assert.ok(!keyHint('sk-ant-api03-SECRETSECRETSECRET1234').includes('SECRET'));
});

test('only failures another key could fix move on to a backup', () => {
  for (const status of [401, 402, 403, 429, 500, 503, 529]) assert.equal(canFailOver({ status }), true, String(status));
  assert.equal(canFailOver({ status: 400, message: 'max_tokens: must be positive' }), false, 'a bad request fails on every key');
  assert.equal(canFailOver(new Error('Your credit balance is too low')), true);
  assert.equal(canFailOver(new Error('fetch failed')), true);
});

test('provider errors are explained in plain words', () => {
  assert.match(explainError({ status: 401, message: 'invalid x-api-key' }), /rejected this key/);
  assert.match(explainError(new Error('Your credit balance is too low to access the API')), /no credit/);
  assert.match(explainError({ status: 404, message: 'model: gpt-9 not found' }), /model name was not found/);
  assert.equal(explainError({ status: 404, message: 'This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.8-flash for the latest features.' }),
    'This model is no longer available for this key. Choose gemini-3.8-flash instead.');
  assert.match(explainError({ status: 429 }), /rate limiting/);
});

test('keys are tried in order: backups only when the failure is fixable', async () => {
  const fail = (status: number) => () => Promise.reject(Object.assign(new Error(`HTTP ${status}`), { status }));
  const used: string[] = [], failed: string[] = [];
  const seen = { used: (id: string) => used.push(id), failed: (id: string) => failed.push(id) };
  assert.equal(await inOrder([{ id: 'p', run: fail(401) }, { id: 'b1', run: fail(429) }, { id: 'b2', run: async () => 'ok' }], seen), 'ok');
  assert.deepEqual(failed, ['p', 'b1']); assert.deepEqual(used, ['b2']);
  await assert.rejects(inOrder([{ id: 'p', run: fail(400) }, { id: 'b', run: async () => 'never' }]), /HTTP 400/, 'a bad request does not try the backup');
  await assert.rejects(inOrder([{ id: 'p', run: fail(401) }, { id: 'b', run: fail(402) }]), /HTTP 402/, 'all failing: the last reason is reported');
});

test('keys saved the old way move into the list once, with the right primary', async () => {
  const { rows } = await pool.query("insert into accounts (name, plan) values ('keys-test','pro') returning id");
  const a = rows[0].id as string;
  try {
    await setSetting(a, 'anthropicKey', 'sk-ant-api03-legacyclaudekey000011112222');
    await setSetting(a, 'aiProvider', 'openai');
    await setSetting(a, 'providerKey', 'sk-proj-legacyopenaikey0000333344445555');
    await setSetting(a, 'aiModel', 'gpt-5');
    await adoptLegacyKeys(a); await adoptLegacyKeys(a);
    const { rows: keys } = await pool.query('select label, provider, is_primary, key_hint, model from ai_keys where account_id=$1 order by sort', [a]);
    assert.equal(keys.length, 2, 'moved once, not twice');
    assert.deepEqual(keys.map((k) => [k.provider, k.is_primary]), [['anthropic', false], ['openai', true]], 'the provider in use stays primary');
    assert.equal(keys[1].model, 'gpt-5');
    assert.ok(!JSON.stringify(keys).includes('legacyopenaikey0000'), 'only hints are readable');
    assert.equal((await activeKeys(a))[0].provider, 'openai', 'the primary is used first');
  } finally {
    await pool.query('delete from accounts where id=$1', [a]);
    await pool.end();
  }
});
