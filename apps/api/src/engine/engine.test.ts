import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TEMPLATES, validateWorkflow, type Workflow } from '@crmagents/shared';
import { execute, newState } from './executor.js';
import type { Env } from './nodes.js';
import { render } from './template.js';

function mockEnv(over: Partial<{ score: number }> = {}) {
  const calls: { fn: string; args: any[] }[] = [];
  const sf: any = {
    getRecord: async (...a: any[]) => (calls.push({ fn: 'getRecord', args: a }), { Id: a[1], Subject: 'Printer broken', Description: 'help', CaseNumber: '1' }),
    createRecord: async (...a: any[]) => (calls.push({ fn: 'createRecord', args: a }), { id: 'new1' }),
    updateRecord: async (...a: any[]) => (calls.push({ fn: 'updateRecord', args: a })),
    saveMany: async (ops: any[]) => (calls.push({ fn: 'saveMany', args: [ops] }), ops.map(() => ({ ok: true, id: 'new1' }))),
    query: async (soql: string) => (calls.push({ fn: 'query', args: [soql] }), { totalSize: 2, records: [{ Subject: 'A', CaseNumber: '1', Status: 'New' }, { Subject: 'B', CaseNumber: '2', Status: 'New' }] }),
  };
  const llm: any = {
    complete: async (o: any) => ({
      text: o.schema?.properties?.score ? `{"score": "${over.score ?? 90}", "reason": "good fit"}` : '{"category":"Technical issue","reason":"printer"}',
      usage: { input: 10, cacheWrite: 0, cacheRead: 0, output: 5, costUsd: 0.0001 }, trace: [],
    }),
    agent: async ({ prompt }: { prompt: string }) => ({ text: `echo: ${prompt}`, usage: { input: 5, cacheWrite: 0, cacheRead: 0, output: 5, costUsd: 0.0001 }, trace: [] }),
  };
  return { env: { sf, llm } as Env, calls };
}

const tpl = (id: string): Workflow => TEMPLATES.find((t) => t.id === id)!.workflow;

test('all templates are valid graphs', () => {
  for (const t of TEMPLATES) validateWorkflow(t.workflow);
});

test('case triage runs end to end', async () => {
  const { env, calls } = mockEnv();
  const st = newState({ recordId: '500XX' });
  const out = await execute(tpl('case-triage'), env, st);
  assert.equal(out.status, 'done');
  assert.equal(st.final, 'Classified as Technical issue');
  const task = calls.find((c) => c.fn === 'createRecord')!;
  assert.equal(task.args[0], 'Task');
  assert.equal(task.args[1].WhatId, '500XX');
  assert.equal(task.args[1].Subject, 'Triage: Technical issue');
});

test('branch follows only the true path', async () => {
  const { env, calls } = mockEnv({ score: 90 });
  const st = newState({ recordId: '00QXX' });
  await execute(tpl('lead-qualification'), env, st);
  assert.equal(calls.filter((c) => c.fn === 'createRecord').length, 1);
  assert.equal(calls.find((c) => c.fn === 'createRecord')!.args[1].WhoId, '00QXX');
});

test('branch false path skips the task but still reaches the join', async () => {
  const { env, calls } = mockEnv({ score: 10 });
  const st = newState({ recordId: '00QXX' });
  const out = await execute(tpl('lead-qualification'), env, st);
  assert.equal(out.status, 'done');
  assert.equal(calls.filter((c) => c.fn === 'createRecord').length, 0);
  assert.match(String(st.final), /Score 10/);
});

test('loop runs the body per item and continues on done', async () => {
  const { env } = mockEnv();
  const st = newState({});
  const out = await execute(tpl('stale-case-followups'), env, st);
  assert.equal(out.status, 'done');
  assert.match(String(st.final), /Drafted 2 follow-ups/);
  assert.match(String(st.final), /case 1: A/);
  assert.match(String(st.final), /case 2: B/);
});

test('loop writes go to Salesforce in one batch, and a failed record is reported', async () => {
  const { env, calls } = mockEnv();
  const wf: Workflow = {
    nodes: [
      { id: 't', type: 'trigger.manual', position: { x: 0, y: 0 }, config: {} },
      { id: 'q', type: 'sf.query', position: { x: 0, y: 0 }, config: { soql: 'SELECT Id FROM Case' } },
      { id: 'l', type: 'logic.loop', position: { x: 0, y: 0 }, config: { items: '{{q.records}}' } },
      { id: 'u', type: 'sf.updateRecord', position: { x: 0, y: 0 }, config: { sobject: 'Case', id: '{{item.CaseNumber}}', fields: '{"Status":"Working"}' } },
    ],
    edges: [{ id: 'a', source: 't', target: 'q' }, { id: 'b', source: 'q', target: 'l' }, { id: 'c', source: 'l', target: 'u', sourceHandle: 'each' }],
  };
  assert.equal((await execute(wf, env, newState({}))).status, 'done');
  assert.equal(calls.filter((c) => c.fn === 'updateRecord').length, 0);
  const batch = calls.filter((c) => c.fn === 'saveMany');
  assert.equal(batch.length, 1);
  assert.deepEqual(batch[0].args[0].map((o: any) => [o.kind, o.id]), [['update', '1'], ['update', '2']]);

  env.sf.saveMany = async (ops: any[]) => ops.map((_o: any, i: number) => (i === 1 ? { ok: false, error: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: Reason is required' } : { ok: true }));
  const out = await execute(wf, env, newState({}));
  assert.equal(out.status, 'error');
  assert.match(String(out.error), /1 of 2 changes saved; 1 failed: item 2 .*Reason is required/);
});

test('approval pauses, then resumes on approve and on reject', async () => {
  for (const approve of [true, false]) {
    const { env, calls } = mockEnv();
    const wf = tpl('opportunity-next-step');
    const st = newState({ recordId: '006XX' });
    const first = await execute(wf, env, st);
    assert.equal(first.status, 'waiting');
    assert.equal(calls.filter((c) => c.fn === 'createRecord').length, 0);
    // survive a database round trip
    const restored = JSON.parse(JSON.stringify(st));
    restored.decision = { nodeId: restored.pending, approve };
    const second = await execute(wf, env, restored);
    assert.equal(second.status, 'done');
    assert.equal(calls.filter((c) => c.fn === 'createRecord').length, approve ? 1 : 0);
  }
});

test('SOQL values are escaped', async () => {
  const s = render("SELECT Id FROM Account WHERE Name = '{{trigger.input}}'", { trigger: { input: "x' OR Name != '" } }, 'soql');
  assert.equal(s, "SELECT Id FROM Account WHERE Name = 'x\\' OR Name != \\''");
});

test('cycles are rejected', () => {
  assert.throws(() => validateWorkflow({
    nodes: [
      { id: 'a', type: 'util.set', position: { x: 0, y: 0 }, config: {} },
      { id: 'b', type: 'util.set', position: { x: 0, y: 0 }, config: {} },
    ],
    edges: [{ id: '1', source: 'a', target: 'b' }, { id: '2', source: 'b', target: 'a' }],
  }), /cycle/);
});

test('a failing node stops the run with a clear error', async () => {
  const { env } = mockEnv();
  const wf: Workflow = {
    nodes: [
      { id: 'trigger_1', type: 'trigger.manual', position: { x: 0, y: 0 }, config: {} },
      { id: 'q', type: 'sf.query', position: { x: 0, y: 0 }, config: { soql: 'DELETE FROM Account' } },
    ],
    edges: [{ id: 'e', source: 'trigger_1', target: 'q', sourceHandle: 'out' }],
  };
  const out = await execute(wf, env, newState({}));
  assert.equal(out.status, 'error');
  assert.match(out.error!, /Only SELECT/);
});

test('rules-first triage spends AI only on cases the rules cannot decide', async () => {
  const wf = tpl('case-triage-rules-first');
  const run = async (record: Record<string, string>) => {
    let aiCalls = 0;
    const tasks: any[] = [];
    const env = {
      sf: {
        getRecord: async () => record,
        createRecord: async (_o: string, f: any) => (tasks.push(f), { id: 'T1' }),
      },
      llm: {
        complete: async () => (aiCalls++, { text: '{"category":"Technical issue","reason":"r","confidence":"high"}', usage: { input: 1, cacheWrite: 0, cacheRead: 0, output: 1, costUsd: 0.001 }, trace: [] }),
        agent: async () => { throw new Error('unused'); },
      },
    } as unknown as Env;
    const st = newState({ recordId: '500X' });
    const out = await execute(wf, env, st);
    assert.equal(out.status, 'done');
    return { aiCalls, tasks, final: String(st.final) };
  };

  const closed = await run({ Subject: 'Refund please', Status: 'Closed' });
  assert.equal(closed.aiCalls, 0);
  assert.equal(closed.tasks.length, 0);
  assert.match(closed.final, /Skipped/);

  const refund = await run({ Subject: 'Need a REFUND', Description: 'charged twice', Status: 'New' });
  assert.equal(refund.aiCalls, 0);
  assert.equal(refund.tasks[0].Subject, 'Triage: Billing (rule)');

  const other = await run({ Subject: 'Printer broken', Description: 'paper jam', Status: 'New' });
  assert.equal(other.aiCalls, 1);
  assert.equal(other.tasks[0].Subject, 'Triage: Technical issue');
});

test('no-AI leads template returns a table without any AI call', async () => {
  const env = {
    sf: { query: async () => ({ totalSize: 2, records: [{ Name: 'A', Company: 'X, Inc' }, { Name: 'B', Company: 'Y' }] }) },
    llm: { complete: async () => { throw new Error('AI must not be called'); }, agent: async () => { throw new Error('AI must not be called'); } },
  } as unknown as Env;
  const st = newState({});
  await execute(tpl('list-leads-no-ai'), env, st);
  assert.equal(st.final, '2 leads:\nName,Company\nA,"X, Inc"\nB,Y');
});

test('classify escalates to the default model only when the cheap model is unsure', async () => {
  const node = { id: 'c', type: 'ai.classify', position: { x: 0, y: 0 }, config: { text: 't', categories: 'A\nB', model: 'claude-haiku-5-5', escalate: 'when unsure' } };
  const calls: any[] = [];
  const envFor = (first: string) => ({
    sf: {},
    llm: {
      complete: async (o: any) => {
        calls.push(o);
        const answer = calls.length === 1 ? { category: 'A', reason: 'r', confidence: first } : { category: 'B', reason: 'strong', confidence: 'high' };
        return { text: JSON.stringify(answer), usage: { input: 1, cacheWrite: 0, cacheRead: 0, output: 1, costUsd: 0.001 }, trace: [] };
      },
      agent: async () => { throw new Error('x'); },
    },
  } as unknown as Env);
  const { EXECUTORS } = await import('./nodes.js');

  const sure = await EXECUTORS['ai.classify'](node as any, {}, envFor('high'));
  assert.equal(calls.length, 1);
  assert.equal(sure.output.category, 'A');
  assert.equal(sure.output.escalated, false);

  calls.length = 0;
  const unsure = await EXECUTORS['ai.classify'](node as any, {}, envFor('low'));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].model, undefined); // second call uses the platform default (strong) model
  assert.equal(unsure.output.category, 'B');
  assert.equal(unsure.output.escalated, true);
  assert.equal(unsure.usage!.costUsd, 0.002);

  // A block on the default model escalates on its own when the workspace routes to the low-cost model first.
  calls.length = 0;
  const routed = envFor('low') as any;
  routed.llm.routing = 'smart'; routed.llm.strongModel = 'claude-opus-5-5';
  const auto = await EXECUTORS['ai.classify']({ ...node, config: { text: 't', categories: 'A\nB' } } as any, {}, routed);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].model, 'claude-opus-5-5');
  assert.equal(auto.output.escalated, true);

  calls.length = 0;
  await EXECUTORS['ai.classify']({ ...node, config: { ...node.config, escalate: 'never' } } as any, {}, envFor('low'));
  assert.equal(calls.length, 1);
});

test('classify learns: the closest confirmed examples go into the prompt', async () => {
  const { rankExamples } = await import('./learn.js');
  const ranked = rankExamples('Generator will not start after power cut', [
    { input: 'Invoice charged twice', label: 'Billing' },
    { input: 'Generator does not start after electrical failure', label: 'Equipment Complexity', source: 'correction' },
    { input: 'Generator start delay', label: 'Performance' },
  ], 2);
  assert.deepEqual(ranked.map((e) => e.label), ['Equipment Complexity', 'Performance']);

  let prompt = '';
  const env = {
    sf: {},
    examples: async () => ranked,
    llm: {
      complete: async (o: any) => { prompt = o.prompt; return { text: '{"category":"Equipment Complexity","reason":"r","confidence":"high"}', usage: { input: 1, cacheWrite: 0, cacheRead: 0, output: 1, costUsd: 0 }, trace: [] }; },
      agent: async () => { throw new Error('x'); },
    },
  } as unknown as Env;
  const { EXECUTORS } = await import('./nodes.js');
  const node = { id: 'c', type: 'ai.classify', position: { x: 0, y: 0 }, config: { text: 'Generator will not start after power cut', categories: 'Equipment Complexity\nPerformance\nBreakdown' } };
  const r = await EXECUTORS['ai.classify'](node as any, {}, env);
  assert.match(prompt, /How this team classified similar items before/);
  assert.match(prompt, /"Generator does not start after electrical failure" → Equipment Complexity/);
  assert.equal(r.output.examplesUsed, 2);
});
