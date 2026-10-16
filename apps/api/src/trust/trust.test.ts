import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Workflow } from '@crmagents/shared';
import { createLlm } from '../agent/llm.js';
import { Masker } from './mask.js';
import { LimitError } from './policy.js';
import { nextStep, safeToResume } from './recovery.js';

const n = (id: string, type: string) => ({ id, type, position: { x: 0, y: 0 }, config: {} });
const e = (s: string, t: string, h = 'out') => ({ id: `${s}->${t}`, source: s, target: t, sourceHandle: h });
const flow: Workflow = {
  nodes: [n('t', 'trigger.salesforce'), n('g', 'sf.getRecord'), n('c', 'ai.classify'), n('k', 'sf.createTask'), n('o', 'util.output')],
  edges: [e('t', 'g'), e('g', 'c'), e('c', 'k'), e('k', 'o')],
};

test('recovery: resumes after reads and AI, stops before a step that changes data', () => {
  // Checkpoint after "get record" (cursor 2): next is the AI step, safe.
  assert.deepEqual(safeToResume(flow, { cursor: 2, active: ['t->g', 'g->c'] }), { safe: true });
  // Checkpoint after "classify" (cursor 3): next is "create task", which may or may not have happened.
  assert.deepEqual(safeToResume(flow, { cursor: 3, active: ['t->g', 'g->c', 'c->k'] }), { safe: false, step: 'sf.createTask' });
  assert.equal(nextStep(flow, { cursor: 5, active: [] }), null);
});

const fakeClient = (reply: (body: any) => any) => {
  const calls: any[] = [];
  return { calls, client: { messages: { create: async (b: any) => { calls.push(b); return reply(b); } } } as any };
};
const ok = (text: string) => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 20 } });

test('masking: the AI never sees personal data; the answer keeps placeholders for later unmasking', async () => {
  const m = new Masker();
  const { calls, client } = fakeClient(() => ok('Reply to [EMAIL_1] today.'));
  const llm = createLlm('k', {} as any, undefined, client, undefined, { masker: m });
  const r = await llm.complete({ system: 'Write a reply.', prompt: 'From: ravi@acme.in, phone +91 98450 12345' });
  const sent = JSON.stringify(calls[0]);
  assert.ok(!sent.includes('ravi@acme.in') && !sent.includes('98450'), sent);
  assert.match(sent, /\[EMAIL_1\].*\[PHONE_1\]/);
  assert.equal(m.unmaskText(r.text), 'Reply to ravi@acme.in today.');
});

test('masking: tool calls get real values; tool results go back to the AI masked', async () => {
  const m = new Masker();
  m.maskText('ravi@acme.in');
  let toolInput: any;
  const tools = await import('../agent/tools.js');
  const orig = tools.TOOLS.soql_query.run;
  tools.TOOLS.soql_query.run = async (_sf: any, input: any) => { toolInput = input; return [{ Name: 'Ravi', Email: 'ravi@acme.in', Phone: '+91 98450 12345' }]; };
  let turn = 0;
  const { calls, client } = fakeClient(() => (turn++ === 0
    ? { content: [{ type: 'tool_use', id: 'u1', name: 'soql_query', input: { soql: "SELECT Name FROM Contact WHERE Email = '[EMAIL_1]'" } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } }
    : ok('Found [EMAIL_1].')));
  try {
    const llm = createLlm('k', {} as any, undefined, client, undefined, { masker: m });
    await llm.agent({ system: 's', prompt: 'find ravi', tools: ['soql_query'] });
  } finally { tools.TOOLS.soql_query.run = orig; }
  assert.equal(toolInput.soql, "SELECT Name FROM Contact WHERE Email = 'ravi@acme.in'");
  const second = JSON.stringify(calls[1].messages);
  assert.ok(!second.includes('ravi@acme.in') && !second.includes('98450'), second);
});

test('limits: a run stops at its AI-call cap', async () => {
  const { client } = fakeClient(() => ok('ok'));
  const counters = { aiCalls: 0, toolCalls: 0, tokens: 0 };
  const llm = createLlm('k', {} as any, undefined, client, undefined, { limits: { aiCalls: 2, toolCalls: 5, tokens: 1e6 }, counters });
  await llm.complete({ system: 's', prompt: 'a' });
  await llm.complete({ system: 's', prompt: 'b' });
  await assert.rejects(llm.complete({ system: 's', prompt: 'c' }), LimitError);
  assert.equal(counters.aiCalls, 2);
  assert.equal(counters.tokens, 240);
});

// ---------- Approvals: ask-first steps and approval rules ----------
import { execute, newState } from '../engine/executor.js';
import { ApprovalRequired } from '../smart/policies.js';

const taskFlow = (askFirst: string): Workflow => ({
  nodes: [n('t', 'trigger.manual'), { ...n('k', 'sf.createTask'), config: { subject: 'Call {{trigger.input}}', askFirst } }, { ...n('o', 'util.output'), config: { value: 'done' } }],
  edges: [e('t', 'k'), e('k', 'o')],
});
const envWith = (writes: unknown[], guard?: any) => ({ sf: { createRecord: async (_o: string, f: unknown) => { writes.push(f); return { id: '00T1' }; } }, llm: {} as any, guard } as any);

test('approvals: "ask before running" pauses with what would change; approve runs it, reject skips it', async () => {
  const writes: unknown[] = [];
  const flow = taskFlow('Yes');
  const st = newState({ input: 'Ravi' });
  assert.equal((await execute(flow, envWith(writes), st)).status, 'waiting');
  assert.equal(st.pending, 'k');
  assert.match(String((st.steps.at(-1)!.output as any).message), /Approve "sf.createTask"\?\n- Create Task: .*Call Ravi/);
  assert.equal(writes.length, 0);

  st.decision = { nodeId: 'k', approve: true };
  assert.equal((await execute(flow, envWith(writes), st)).status, 'done');
  assert.equal(writes.length, 1);

  const st2 = newState({ input: 'Asha' });
  await execute(flow, envWith(writes), st2);
  st2.decision = { nodeId: 'k', approve: false };
  assert.equal((await execute(flow, envWith(writes), st2)).status, 'done');
  assert.equal(writes.length, 1); // nothing new written
  assert.match(String(st2.final), /Not approved/);
});

test('approvals: a rule that needs approval pauses the run; preview only notes it', async () => {
  const writes: unknown[] = [];
  const guard = async (ctx: any) => { if (!ctx.approved) throw new ApprovalRequired('Workspace rule: Ask before creating tasks'); };
  const st = newState({ input: 'Ravi' });
  assert.equal((await execute(taskFlow('No'), envWith(writes, guard), st)).status, 'waiting');
  assert.match(String((st.steps.at(-1)!.output as any).message), /Ask before creating tasks/);
  st.decision = { nodeId: 'k', approve: true };
  assert.equal((await execute(taskFlow('No'), envWith(writes, guard), st)).status, 'done');
  assert.equal(writes.length, 1);

  const dry = newState({ input: 'x' });
  assert.equal((await execute(taskFlow('No'), { ...envWith(writes, guard), dryRun: true }, dry)).status, 'done');
  assert.match(String((dry.steps.find((s) => s.nodeId === 'k')!.output as any).wouldDo), /^Ask for approval/);
  assert.equal(writes.length, 1);
});

test('approvals: not allowed inside a loop (one approval before the loop instead)', async () => {
  const flow: Workflow = {
    nodes: [n('t', 'trigger.manual'), { ...n('l', 'logic.loop'), config: { items: '{{trigger.list}}' } }, { ...n('k', 'sf.createTask'), config: { subject: 'x', askFirst: 'Yes' } }],
    edges: [e('t', 'l'), e('l', 'k', 'each')],
  };
  const out = await execute(flow, envWith([]), newState({ list: [1] }));
  assert.equal(out.status, 'error');
  assert.match(String(out.error), /inside a loop/);
});

// ---------- Phase 3: Wait step, allowed fields, conversation history ----------
import { waitUntil } from '../engine/executor.js';
import { checkAllowedFields } from '../engine/service.js';

test('wait: for a while, until a date, and sleeping then resuming at the same step', async () => {
  const now = new Date('2026-10-16T10:00:00Z');
  assert.equal(waitUntil({ mode: 'For a while', amount: 3, unit: 'days' }, {}, now).toISOString(), '2026-10-19T10:00:00.000Z');
  assert.equal(waitUntil({ mode: 'Until a date and time', until: '{{trigger.due}}' }, { trigger: { due: '2026-11-01T09:00:00Z' } }, now).toISOString(), '2026-11-01T09:00:00.000Z');
  assert.throws(() => waitUntil({ mode: 'Until a date and time', until: 'soon' }, {}, now), /not a date/);

  const writes: unknown[] = [];
  const flow: Workflow = {
    nodes: [n('t', 'trigger.manual'), { ...n('w', 'logic.wait'), config: { mode: 'For a while', amount: 1, unit: 'days' } }, { ...n('k', 'sf.createTask'), config: { subject: 'Follow up' } }],
    edges: [e('t', 'w'), e('w', 'k')],
  };
  const st = newState({});
  assert.equal((await execute(flow, envWith(writes), st)).status, 'sleeping');
  assert.ok(st.sleepUntil && Date.parse(st.sleepUntil) > Date.now());
  assert.equal(writes.length, 0);
  st.woke = st.pending; st.pending = undefined; // what wakeRuns does
  assert.equal((await execute(flow, envWith(writes), st)).status, 'done');
  assert.equal(writes.length, 1);
  assert.equal(st.steps.filter((s) => s.status === 'waiting').length, 0);
});

test('allowed fields: only listed fields may be changed on that object', () => {
  const allowed = { Case: ['Status', 'Priority'] };
  assert.doesNotThrow(() => checkAllowedFields(allowed, { action: 'update', object: 'Case', values: { Status: 'Working', priority: 'High' } }));
  assert.throws(() => checkAllowedFields(allowed, { action: 'update', object: 'Case', values: { Status: 'x', OwnerId: '005' } }), /only change Status, Priority on Case; it tried OwnerId/);
  assert.doesNotThrow(() => checkAllowedFields(allowed, { action: 'update', object: 'Lead', values: { OwnerId: '005' } }));
  assert.doesNotThrow(() => checkAllowedFields(allowed, { action: 'task', object: 'Task', values: { Subject: 'x' } }));
});

test('assistants: earlier turns are sent, masked', async () => {
  const { calls, client } = fakeClient(() => ok('Yes, 4 of them.'));
  const llm = createLlm('k', {} as any, undefined, client, undefined, { masker: new Masker() });
  await llm.agent({ system: 's', prompt: 'And how many are high priority?', tools: [], history: [{ role: 'user', text: 'Open cases for ravi@acme.in?' }, { role: 'assistant', text: 'There are 9.' }] });
  const msgs = calls[0].messages;
  // (the fake keeps a live reference, so the reply appended after the call shows up as a 4th message)
  assert.equal(msgs[0].content, 'Open cases for [EMAIL_1]?');
  assert.equal(msgs[2].content, 'And how many are high priority?');
  assert.equal(msgs[1].content, 'There are 9.');
});
