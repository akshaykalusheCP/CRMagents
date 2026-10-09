import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compactRecord } from '../salesforce/client.js';
import { createLlm } from './llm.js';
import { usageFrom } from './pricing.js';
import { TOOLS } from './tools.js';

/** Fake Claude client: records every request and replays scripted responses. */
function fakeClient(responses: any[]) {
  const calls: any[] = [];
  return {
    calls,
    client: { messages: { create: async (params: any) => { calls.push(params); return responses.shift(); } } } as any,
  };
}
const usage = { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const text = (t: string) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: t }], usage });

test('records lose attributes, nulls and empty strings, recursively', () => {
  const r = compactRecord({
    attributes: { type: 'Case', url: '/x' }, Id: '500', Subject: 'Hi', Description: null, Origin: '',
    Account: { attributes: { type: 'Account' }, Name: 'Acme', Phone: null },
  });
  assert.deepEqual(r, { Id: '500', Subject: 'Hi', Account: { Name: 'Acme' } });
});

test('describe_object is compact and searchable, with picklists only when narrowed', async () => {
  const fields = [
    { name: 'Id', label: 'Case ID', type: 'id', updateable: false },
    { name: 'Status', label: 'Status', type: 'picklist', updateable: true, picklistValues: [{ value: 'New', active: true }, { value: 'Old', active: false }, { value: 'Closed', active: true }] },
    { name: 'OwnerId', label: 'Owner', type: 'reference', updateable: true, referenceTo: ['User', 'Group'] },
  ];
  const sf: any = { describe: async () => fields };
  const all = await TOOLS.describe_object.run(sf, { sobject: 'Case' });
  assert.match(String(all), /Id: id \(read-only\)/);
  assert.match(String(all), /OwnerId: reference\(User\|Group\)/);
  const narrowed = String(await TOOLS.describe_object.run(sf, { sobject: 'Case', search: 'status' }));
  assert.match(narrowed, /Status: picklist \[New, Closed\]/);
  assert.doesNotMatch(narrowed, /OwnerId/);
});

test('get_record passes the requested field list through', async () => {
  let seen: unknown;
  const sf: any = { getRecord: async (_o: string, _i: string, f?: string[]) => ((seen = f), {}) };
  await TOOLS.get_record.run(sf, { sobject: 'Case', id: '500', fields: ['Subject', 'Status'] });
  assert.deepEqual(seen, ['Subject', 'Status']);
});

test('agent loop caches only when tools make it multi-turn, and appends history unchanged', async () => {
  const sf: any = { query: async () => ({ totalSize: 1, records: [{ Id: '1' }] }) };
  const toolTurn = {
    stop_reason: 'tool_use',
    content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 't1', name: 'soql_query', input: { soql: 'SELECT Id FROM Case' } }],
    usage: { ...usage, cache_creation_input_tokens: 500 },
  };
  const final = { ...text('done'), usage: { ...usage, cache_read_input_tokens: 500 } };
  const { client, calls } = fakeClient([toolTurn, final]);
  const r = await createLlm('k', sf, undefined, client).agent({ system: 'S', prompt: 'P', tools: ['soql_query'] });
  assert.equal(r.text, 'done');
  assert.deepEqual(calls[0].cache_control, { type: 'ephemeral' });
  assert.deepEqual(calls[0].system[0].cache_control, { type: 'ephemeral' });
  // second request carries the first response verbatim (thinking block included) - append-only history
  assert.deepEqual(calls[1].messages[1].content, toolTurn.content);
  assert.equal(r.usage.cacheWrite, 500);
  assert.equal(r.usage.cacheRead, 500);

  const noTools = fakeClient([text('hi')]);
  await createLlm('k', sf, undefined, noTools.client).agent({ system: 'S', prompt: 'P', tools: [] });
  assert.equal(noTools.calls[0].cache_control, undefined);
  assert.equal(typeof noTools.calls[0].system, 'string');
});

test('oversized tool results are capped with a hint to narrow the request', async () => {
  const big = Array.from({ length: 50 }, (_, i) => ({ Id: String(i), Description: 'x'.repeat(2000) }));
  const sf: any = { query: async () => ({ totalSize: 50, records: big }) };
  const toolTurn = { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'soql_query', input: { soql: 'SELECT Id FROM Case' } }], usage };
  const { client, calls } = fakeClient([toolTurn, text('ok')]);
  await createLlm('k', sf, undefined, client).agent({ system: 'S', prompt: 'P', tools: ['soql_query'] });
  const sent = calls[1].messages[2].content[0].content as string;
  assert.ok(sent.length < 25_000);
  assert.match(sent, /truncated: result too large/);
});

test('structured output, model and effort are sent only when asked for', async () => {
  const sf: any = {};
  const a = fakeClient([text('{"category":"A","reason":"r"}')]);
  await createLlm('k', sf, undefined, a.client).complete({ system: 'S', prompt: 'P', schema: { type: 'object' }, effort: 'low', model: 'claude-sonnet-5-5' });
  assert.deepEqual(a.calls[0].output_config, { effort: 'low', format: { type: 'json_schema', schema: { type: 'object' } } });
  assert.equal(a.calls[0].model, 'claude-sonnet-5-5');
  assert.equal(a.calls[0].cache_control, undefined);

  const b = fakeClient([text('plain')]);
  await createLlm('k', sf, undefined, b.client).complete({ system: 'S', prompt: 'P' });
  assert.equal(b.calls[0].output_config, undefined);
});

test('spend guard stops a run before the next model call', async () => {
  const sf: any = { query: async () => ({ totalSize: 0, records: [] }) };
  const toolTurn = { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'soql_query', input: { soql: 'SELECT Id FROM Case' } }], usage };
  const { client, calls } = fakeClient([toolTurn, text('never')]);
  const guard = async (spent: number) => { if (spent > 0) throw new Error('budget reached'); };
  await assert.rejects(createLlm('k', sf, guard, client).agent({ system: 'S', prompt: 'P', tools: ['soql_query'] }), /budget reached/);
  assert.equal(calls.length, 1);
});

test('cost uses cache-read pricing for cached tokens', () => {
  const u = usageFrom('claude-opus-5-5', { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0 });
  assert.equal(u.costUsd, 4 + 0.2);
});

test('identical single-shot requests reuse the earlier answer; tool runs never do', async () => {
  const store = new Map<string, string>();
  const results = { get: async (k: string) => store.get(k) ?? null, set: async (k: string, t: string) => void store.set(k, t) };
  const sf: any = { query: async () => ({ totalSize: 0, records: [] }) };

  const a = fakeClient([text('{"category":"A","reason":"r"}')]);
  const llm = createLlm('k', sf, undefined, a.client, results);
  const first = await llm.complete({ system: 'S', prompt: 'same', schema: { type: 'object' } });
  const second = await llm.complete({ system: 'S', prompt: 'same', schema: { type: 'object' } });
  assert.equal(a.calls.length, 1);
  assert.equal(second.reused, true);
  assert.equal(second.text, first.text);
  assert.equal(second.usage.costUsd, 0);

  // a different input is a different question
  const b = fakeClient([text('x'), text('y')]);
  const llm2 = createLlm('k', sf, undefined, b.client, results);
  await llm2.complete({ system: 'S', prompt: 'one' });
  await llm2.complete({ system: 'S', prompt: 'two' });
  assert.equal(b.calls.length, 2);

  // agents with tools read live data, so they always call the model
  const c = fakeClient([text('live 1'), text('live 2')]);
  const llm3 = createLlm('k', sf, undefined, c.client, results);
  await llm3.agent({ system: 'S', prompt: 'P', tools: ['soql_query'] });
  await llm3.agent({ system: 'S', prompt: 'P', tools: ['soql_query'] });
  assert.equal(c.calls.length, 2);
});

test('records become a CSV table with flattened relationships and escaped values', async () => {
  const { recordsToTable } = await import('../salesforce/table.js');
  const t = recordsToTable([
    { Id: '1', Title: 'SVP, Sales', Owner: { Name: 'Ann' } },
    { Id: '2', Notes: 'said "hi"\nbye', Contacts: { totalSize: 1, done: true, records: [{ Name: 'Bo' }] } },
  ]);
  assert.equal(t, 'Id,Title,Owner.Name,Notes,Contacts\n1,"SVP, Sales",Ann,,\n2,,,"said ""hi""\nbye","[{""Name"":""Bo""}]"');
});

test('SOQL tool returns a CSV table and text results are not JSON-escaped', async () => {
  const sf: any = { query: async () => ({ totalSize: 3, records: [{ Id: '1', Name: 'A' }, { Id: '2', Name: 'B' }] }) };
  const out = await TOOLS.soql_query.run(sf, { soql: 'SELECT Id, Name FROM Lead' });
  assert.equal(out, '3 row(s), showing 2 (CSV):\nId,Name\n1,A\n2,B');
  const toolTurn = { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'soql_query', input: { soql: 'SELECT Id FROM Lead' } }], usage };
  const { client, calls } = fakeClient([toolTurn, text('ok')]);
  await createLlm('k', sf, undefined, client).agent({ system: 'S', prompt: 'P', tools: ['soql_query'] });
  assert.equal(calls[1].messages[2].content[0].content, '3 row(s), showing 2 (CSV):\nId,Name\n1,A\n2,B');
});
