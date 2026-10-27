import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLlm } from './llm.js';
import { fromChat, openAiCompatible, reasoningEffort, toChat } from './provider.js';

test('requests translate to the OpenAI shape: system, tools, tool results, structured output, low-cost model', () => {
  const r = toChat({
    model: 'claude-haiku-5-5', max_tokens: 100,
    system: [{ type: 'text', text: 'Be brief.' }],
    tools: [{ name: 'soql_query', description: 'q', input_schema: { type: 'object' } }],
    output_config: { format: { type: 'json_schema', schema: { type: 'object' } } },
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'checking' }, { type: 'tool_use', id: 'c1', name: 'soql_query', input: { soql: 'SELECT Id FROM Case' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '2 rows', is_error: false }] },
    ],
  }, { model: 'gpt-main', fastModel: 'gpt-mini' });
  assert.equal(r.model, 'gpt-mini');
  assert.deepEqual(r.messages.map((m: any) => m.role), ['system', 'user', 'assistant', 'tool']);
  assert.equal(r.messages[2].tool_calls[0].function.arguments, '{"soql":"SELECT Id FROM Case"}');
  assert.equal(r.messages[3].tool_call_id, 'c1');
  assert.equal(r.tools![0].function.name, 'soql_query');
  assert.equal(r.response_format!.type, 'json_schema');
});

test('replies translate back, with the provider\'s price', () => {
  const m = fromChat({ id: 'x', model: 'gpt-main', choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'c2', function: { name: 'get_record', arguments: '{"id":"500A"}' } }] } }], usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 200 } } }, { priceIn: 2, priceOut: 8 });
  assert.equal(m.stop_reason, 'tool_use');
  assert.deepEqual(m.content[0], { type: 'tool_use', id: 'c2', name: 'get_record', input: { id: '500A' } });
  assert.equal(m.usage.input_tokens, 800);
  assert.equal(m.usage.cache_read_input_tokens, 200);
  assert.equal(m.usage.cost_usd, (1000 * 2 + 100 * 8) / 1_000_000);
});

test('a whole tool-using answer works through another provider', async () => {
  const replies = [
    { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'c1', function: { name: 'soql_query', arguments: '{"soql":"SELECT Id FROM Case"}' } }] } }], usage: { prompt_tokens: 50, completion_tokens: 10 } },
    { choices: [{ finish_reason: 'stop', message: { content: 'There are 2 cases.' } }], usage: { prompt_tokens: 80, completion_tokens: 8 } },
  ];
  const bodies: any[] = [];
  const fakeFetch = (async (_u: string, init: any) => { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify(replies.shift())); }) as typeof fetch;
  const client = openAiCompatible({ baseUrl: 'https://ai.example/v1', key: 'k', model: 'm', fastModel: 'f', priceIn: 1, priceOut: 2, fetchImpl: fakeFetch });
  const sf = { query: async () => ({ totalSize: 2, records: [{ Id: '500A' }, { Id: '500B' }] }) } as any;
  const r = await createLlm('', sf, undefined, client).agent({ system: 's', prompt: 'how many cases?', tools: ['soql_query'] });
  assert.equal(r.text, 'There are 2 cases.');
  assert.equal(bodies[1].messages.at(-1).role, 'tool');
  assert.match(bodies[1].messages.at(-1).content, /2 row\(s\)/);
  assert.ok(Math.abs(r.usage.costUsd - ((50 + 80) * 1 + (10 + 8) * 2) / 1_000_000) < 1e-12);
});

test('thinking effort is sent only where the endpoint understands it', () => {
  const gem = 'https://generativelanguage.googleapis.com/v1beta/openai';
  assert.equal(reasoningEffort(gem, 'gemini-3.8-flash'), 'low');
  assert.equal(reasoningEffort(gem, 'gemini-3.8-flash', 'minimal'), 'minimal');
  assert.equal(reasoningEffort('https://api.openai.com/v1', 'gpt-5', 'minimal'), 'minimal');
  assert.equal(reasoningEffort('https://api.openai.com/v1', 'gpt-4o', 'minimal'), undefined);
  assert.equal(reasoningEffort('https://api.mistral.ai/v1', 'mistral-large-latest', 'minimal'), undefined);
  assert.equal(toChat({ model: 'x', max_tokens: 9, messages: [{ role: 'user', content: 'hi' }] }, { model: 'gemini-3.8-flash', fastModel: 'gemini-3.8-flash', baseUrl: gem }).reasoning_effort, 'low');
});

test('thinking tokens left out of completion_tokens still count as output', () => {
  const r = fromChat({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 311 } }, { priceIn: 1, priceOut: 10 });
  assert.equal(r.usage.output_tokens, 301);
});

test('a thinking level the model rejects is dropped and the request sent again', async () => {
  const sent: any[] = [];
  const fetchImpl = (async (_u: string, init: any) => {
    const b = JSON.parse(init.body); sent.push(b);
    return b.reasoning_effort
      ? new Response('{"error":{"code":400,"message":"Thinking level MINIMAL is not supported for this model."}}', { status: 400 })
      : new Response(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }));
  }) as typeof fetch;
  const c = openAiCompatible({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', key: 'k', model: 'gemini-3.8-flash', fastModel: 'gemini-3.8-flash', priceIn: 1, priceOut: 1, fetchImpl });
  const r: any = await c.messages.create({ model: 'x', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] } as never);
  assert.equal(r.content[0].text, 'OK');
  assert.equal(sent.length, 2);
  assert.equal(sent[1].reasoning_effort, undefined);
});
