import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLlm } from './llm.js';
import { deliverResults, endRemote, formatResult, remoteExecutor, takeCalls } from './remote.js';

test('assistant tools run inside Salesforce: handed out, answered, and the AI continues', async () => {
  const exec = remoteExecutor('run-1');
  // Knowledge search and run_agent stay on our side.
  assert.equal(exec('search_knowledge', { query: 'x' }), undefined);
  const turns = [
    { content: [{ type: 'tool_use', id: 'u1', name: 'soql_query', input: { soql: 'SELECT Id, Name FROM Account' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } },
    { content: [{ type: 'text', text: 'You have 1 account.' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } },
  ];
  const sent: any[] = [];
  const client = { messages: { create: async (b: any) => { sent.push(JSON.parse(JSON.stringify(b))); return turns.shift(); } } } as any;
  const sf = { query: async () => { throw new Error('must not query from our side'); } } as any;
  const llm = createLlm('k', sf, undefined, client, undefined, { exec });
  const answer = llm.agent({ system: 's', prompt: 'how many accounts?', tools: ['soql_query'] });

  // The panel picks up the call...
  let calls: ReturnType<typeof takeCalls> = [];
  for (let i = 0; i < 50 && !calls.length; i++) { await new Promise((r) => setTimeout(r, 10)); calls = takeCalls('run-1'); }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'soql_query');
  assert.deepEqual(takeCalls('run-1'), []); // not handed out twice right away
  // ...runs it in Salesforce as the user and posts the result back.
  assert.equal(deliverResults('run-1', [{ id: calls[0].id, ok: true, result: { totalSize: 1, records: [{ attributes: { type: 'Account' }, Id: '001A', Name: 'Acme' }] } }]), 1);
  const r = await answer;
  assert.equal(r.text, 'You have 1 account.');
  const toolResult = sent[1].messages.at(-1).content[0];
  assert.equal(toolResult.type, 'tool_result');
  assert.match(toolResult.content, /1 row\(s\) \(CSV\):\nId,Name\n001A,Acme/);
  endRemote('run-1');
});

test('a failed tool in Salesforce comes back to the AI as an error', async () => {
  const exec = remoteExecutor('run-2');
  const p = exec('update_record', { sobject: 'Case', id: '500A', fields: {} })!;
  const [c] = takeCalls('run-2');
  deliverResults('run-2', [{ id: c.id, ok: false, error: 'INSUFFICIENT_ACCESS: you cannot edit this case' }]);
  await assert.rejects(p, /INSUFFICIENT_ACCESS/);
  endRemote('run-2');
});

test('describe results read like ours', () => {
  const t = String(formatResult('describe_object', { sobject: 'Case', fields: [{ name: 'Status', type: 'picklist', updateable: true, picklist: ['New', 'Closed'] }, { name: 'AccountId', type: 'reference', updateable: true, referenceTo: ['Account'] }] }));
  assert.match(t, /Status: picklist \[New, Closed\]/);
  assert.match(t, /AccountId: reference\(Account\)/);
});
