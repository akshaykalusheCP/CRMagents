import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateWorkflow } from '@crmagents/shared';
import { execute, newState } from '../engine/executor.js';
import type { Env } from '../engine/nodes.js';
import { detectObjects } from '../salesforce/schema.js';
import { compilePlan } from './compile.js';
import type { Plan, PlanStep } from './plan.js';

const step = (s: Partial<PlanStep> & Pick<PlanStep, 'action'>): PlanStep => ({
  instruction: '', input_fields: [], categories: [], outputs: [], object: '', fields: [], subject: '', message: '', where: '', limit: 0,
  only_if: { value: '', operator: 'equals', compare: '' }, per_record: false, ...s,
});
const plan = (p: Partial<Plan>): Plan => ({
  name: 'T', trigger_kind: 'record', trigger_object: 'Case', schedule: { every: 'day', at: '08:00' }, conditions: [], steps: [], require_approval: true, questions: [], ...p,
});

const triage = plan({
  conditions: [{ field: 'Status', operator: 'not_equals', value: 'Closed' }],
  steps: [
    step({ action: 'classify', input_fields: ['Subject', 'Description'], categories: ['Billing', 'Technical'] }),
    step({ action: 'create_task', subject: 'Triage: {step1.category}', message: 'Reason: {step1.reason}' }),
  ],
});

test('a triage plan compiles to a valid, wired workflow with approval before the write', () => {
  const c = compilePlan(triage);
  assert.deepEqual(c.errors, []);
  validateWorkflow(c.workflow);
  const types = c.workflow.nodes.map((n) => n.type);
  assert.deepEqual(types.filter((t) => t !== 'util.output'), ['trigger.salesforce', 'sf.getRecord', 'logic.branch', 'ai.classify', 'logic.approval', 'sf.createTask']);
  assert.equal(c.workflow.nodes.find((n) => n.type === 'sf.getRecord')!.config.fields, 'Status, Subject, Description');
  const task = c.workflow.nodes.find((n) => n.type === 'sf.createTask')!;
  assert.equal(task.config.subject, 'Triage: {{ai_classify_1.category}}');
  assert.equal(c.workflow.nodes.find((n) => n.type === 'ai.classify')!.config.model, 'claude-haiku-5-5');
  assert.ok(c.summary.some((l) => /approve/.test(l)));
  const approval = c.workflow.nodes.find((n) => n.type === 'logic.approval')!;
  assert.match(String(approval.config.message), /Create Task "Triage: \{\{ai_classify_1\.category\}\}"/); // real value at run time
  assert.doesNotMatch(String(approval.config.message), /\[category\]/);
  assert.ok(c.estimateUsd > 0 && c.estimateUsd < 0.01);
});

test('the compiled workflow actually runs: skip, approve and the AI path', async () => {
  const wf = compilePlan(triage).workflow;
  const run = async (record: Record<string, string>, approve?: boolean) => {
    const tasks: any[] = [];
    let ai = 0;
    const env = {
      sf: { getRecord: async () => record, createRecord: async (_o: string, f: any) => (tasks.push(f), { id: '00T1' }) },
      llm: { complete: async () => (ai++, { text: '{"category":"Billing","reason":"invoice"}', usage: { input: 1, cacheWrite: 0, cacheRead: 0, output: 1, costUsd: 0 }, trace: [] }), agent: async () => { throw new Error('x'); } },
    } as unknown as Env;
    const st = newState({ recordId: '500X' });
    let out = await execute(wf, env, st);
    if (out.status === 'waiting' && approve !== undefined) {
      st.decision = { nodeId: st.pending!, approve };
      out = await execute(wf, env, st);
    }
    return { out, st, tasks, ai };
  };
  const closed = await run({ Status: 'Closed', Subject: 'x' });
  assert.equal(closed.ai, 0);
  assert.match(String(closed.st.final), /Skipped/);

  const yes = await run({ Status: 'New', Subject: 'Invoice wrong' }, true);
  assert.equal(yes.out.status, 'done');
  assert.equal(yes.tasks[0].Subject, 'Triage: Billing');
  assert.equal(yes.tasks[0].WhatId, '500X');

  const no = await run({ Status: 'New', Subject: 'Invoice wrong' }, false);
  assert.equal(no.tasks.length, 0);
  assert.match(String(no.st.final), /Not approved/);
});

test('bad references and impossible steps are reported for the repair call', () => {
  const c = compilePlan(plan({
    trigger_kind: 'manual', trigger_object: '',
    steps: [
      step({ action: 'create_task', subject: '{step2.category}' }),
      step({ action: 'classify', categories: ['A', 'B'], instruction: '{record.Subject}' }),
      step({ action: 'update_record', fields: [] }),
    ],
  }));
  assert.ok(c.errors.some((e) => /step2\.category.*does not run before step 1/.test(e)));
  assert.ok(c.errors.some((e) => /record\.Subject.*not started by a record/.test(e)));
  assert.ok(c.errors.some((e) => /update_record needs a record trigger/.test(e)));
});

test('a no-approval plan has no approval block; query steps need no AI', () => {
  const c = compilePlan(plan({
    trigger_kind: 'manual', trigger_object: '', require_approval: false,
    steps: [step({ action: 'query', object: 'Lead', fields: [{ field: 'Name', value: '' }, { field: 'Company', value: '' }], where: "Status = 'Open'", limit: 10 })],
  }));
  assert.deepEqual(c.errors, []);
  assert.equal(c.workflow.nodes.some((n) => n.type === 'logic.approval'), false);
  assert.equal(c.workflow.nodes.find((n) => n.type === 'sf.query')!.config.soql, "SELECT Name, Company FROM Lead WHERE Status = 'Open' LIMIT 10");
  assert.equal(c.estimateUsd, 0);
});

test('objects are detected from plain English by name or label', () => {
  const all = [
    { name: 'Case', label: 'Case', labelPlural: 'Cases', queryable: true, createable: true, custom: false },
    { name: 'Lead', label: 'Lead', labelPlural: 'Leads', queryable: true, createable: true, custom: false },
    { name: 'Repair_Job__c', label: 'Repair Job', labelPlural: 'Repair Jobs', queryable: true, createable: true, custom: true },
  ];
  assert.deepEqual(detectObjects('When a new case comes in, create a repair job', all).mentioned, ['Case', 'Repair_Job__c']);
  assert.deepEqual(detectObjects('score my leads', all).mentioned, ['Lead']);
});

test('a per-step condition skips only that step and the workflow continues', async () => {
  const p = plan({
    require_approval: false,
    steps: [
      step({ action: 'classify', input_fields: ['Subject'], categories: ['Breakdown', 'Other'] }),
      step({ action: 'update_record', fields: [{ field: 'Priority', value: 'High' }], only_if: { value: '{step1.category}', operator: 'equals', compare: 'Breakdown' } }),
      step({ action: 'create_task', subject: 'Follow up: {step1.category}' }),
    ],
  });
  const c = compilePlan(p);
  assert.deepEqual(c.errors, []);
  validateWorkflow(c.workflow);
  const run = async (category: string) => {
    const updates: any[] = []; const tasks: any[] = [];
    const env = {
      sf: {
        getRecord: async () => ({ Subject: 's' }),
        updateRecord: async (_o: string, _i: string, f: any) => { updates.push(f); },
        createRecord: async (_o: string, f: any) => (tasks.push(f), { id: '00T' }),
      },
      llm: { complete: async () => ({ text: JSON.stringify({ category, reason: 'r' }), usage: { input: 1, cacheWrite: 0, cacheRead: 0, output: 1, costUsd: 0 }, trace: [] }), agent: async () => { throw new Error('x'); } },
    } as unknown as Env;
    const st = newState({ recordId: '500X' });
    assert.equal((await execute(c.workflow, env, st)).status, 'done');
    return { updates, tasks };
  };
  const breakdown = await run('Breakdown');
  assert.deepEqual(breakdown.updates, [{ Priority: 'High' }]);
  assert.equal(breakdown.tasks.length, 1);
  const other = await run('Other');
  assert.equal(other.updates.length, 0);
  assert.equal(other.tasks[0].Subject, 'Follow up: Other');
});

test('preview mode runs AI for real but never writes, sends or waits for approval', async () => {
  const c = compilePlan(plan({
    steps: [
      step({ action: 'classify', input_fields: ['Subject'], categories: ['Billing', 'Other'] }),
      step({ action: 'update_record', fields: [{ field: 'Priority', value: 'High' }] }),
      step({ action: 'create_task', subject: 'Triage: {step1.category}' }),
      step({ action: 'notify_slack', message: 'New {step1.category} case' }),
    ],
  }));
  let writes = 0;
  const env = {
    dryRun: true,
    sf: {
      getRecord: async () => ({ Subject: 'Invoice wrong' }),
      createRecord: async () => { writes++; return { id: 'x' }; },
      updateRecord: async () => { writes++; },
    },
    llm: { complete: async () => ({ text: '{"category":"Billing","reason":"r","confidence":"high"}', usage: { input: 1, cacheWrite: 0, cacheRead: 0, output: 1, costUsd: 0.0001 }, trace: [] }), agent: async () => { throw new Error('x'); } },
  } as unknown as Env;
  const st = newState({ recordId: '500X' });
  const out = await execute(c.workflow, env, st);
  assert.equal(out.status, 'done'); // no pause for approval
  assert.equal(writes, 0);
  const would = st.steps.map((s) => (s.output as any)?.wouldDo).filter(Boolean);
  assert.deepEqual(would, ['Ask for approval', 'Update Case 500X', 'Create Task', 'Post to Slack']);
  assert.equal((st.steps.find((s) => s.type === 'sf.createTask')!.output as any).fields.Subject, 'Triage: Billing');
});

test('scheduled per-record job: one approval for the batch, then a task per record for its owner', async () => {
  const c = compilePlan(plan({
    trigger_kind: 'schedule', trigger_object: '',
    steps: [
      step({ action: 'query', object: 'Opportunity', fields: [{ field: 'Name', value: '' }], where: 'IsClosed = false AND CloseDate < TODAY', limit: 50, per_record: true }),
      step({ action: 'create_task', subject: 'Update {item.Name}', message: 'Close date has passed' }),
    ],
  }));
  assert.deepEqual(c.errors, []);
  validateWorkflow(c.workflow);
  assert.deepEqual(c.workflow.nodes.filter((n) => n.type !== 'util.output').map((n) => n.type), ['trigger.schedule', 'sf.query', 'logic.approval', 'logic.loop', 'sf.createTask']);
  assert.equal(c.workflow.nodes.find((n) => n.type === 'sf.query')!.config.soql, 'SELECT Id, Name, OwnerId FROM Opportunity WHERE IsClosed = false AND CloseDate < TODAY LIMIT 50');
  const records = [{ Id: '006A', Name: 'Big deal', OwnerId: '005X' }, { Id: '006B', Name: 'Small deal', OwnerId: '005Y' }];
  const tasks: any[] = [];
  const env = {
    sf: { query: async () => ({ totalSize: 2, records }), createRecord: async (_o: string, f: any) => (tasks.push(f), { id: '00T' }) },
    llm: { complete: async () => { throw new Error('no AI'); }, agent: async () => { throw new Error('no AI'); } },
  } as unknown as Env;
  const st = newState({});
  assert.equal((await execute(c.workflow, env, st)).status, 'waiting'); // batch approval before any write
  assert.equal(tasks.length, 0);
  st.decision = { nodeId: st.pending!, approve: true };
  assert.equal((await execute(c.workflow, env, st)).status, 'done');
  assert.deepEqual(tasks.map((t) => [t.Subject, t.WhatId, t.OwnerId]), [['Update Big deal', '006A', '005X'], ['Update Small deal', '006B', '005Y']]);
  assert.match(String(st.final), /Processed 2 Opportunity record/);
});

test('org actions: ranking picks matching Flows/Apex, compile wires inputs and approval', async () => {
  const { rankActions } = await import('../salesforce/actions.js');
  const { actionLabel } = await import('./compile.js');
  const actions = [
    { kind: 'flow' as const, name: 'SvcCopilotTmpl__CloseCase', label: 'Close Case' },
    { kind: 'flow' as const, name: 'SvcCopilotTmpl__AddCaseComment', label: 'Add Case Comment' },
    { kind: 'apex' as const, name: 'FSL__ScheduleServiceProcess', label: 'ScheduleServiceAppointments' },
    { kind: 'standard' as const, name: 'emailSimple', label: 'Send email' },
  ];
  const picked = rankActions('When a case is resolved, close the case and email the customer', actions).map((a) => a.name);
  assert.equal(picked[0], 'SvcCopilotTmpl__CloseCase');
  assert.ok(picked.includes('emailSimple'));
  assert.ok(!picked.includes('FSL__ScheduleServiceProcess'));
  assert.deepEqual(rankActions('summarize the account', actions), []);
  assert.equal(actionLabel('flow:SvcCopilotTmpl__CloseCase'), 'Runs Flow: Close Case');
  assert.equal(actionLabel('standard:emailSimple'), 'Sends an email');

  const c = compilePlan(plan({
    steps: [step({ action: 'run_action', org_action: 'flow:SvcCopilotTmpl__CloseCase', fields: [{ field: 'caseId', value: '{record.Id}' }] })],
  }));
  assert.deepEqual(c.errors, []);
  validateWorkflow(c.workflow);
  const types = c.workflow.nodes.map((n) => n.type).filter((t) => t !== 'util.output');
  assert.deepEqual(types, ['trigger.salesforce', 'sf.getRecord', 'logic.approval', 'sf.action']); // writes wait for approval
  const node = c.workflow.nodes.find((n) => n.type === 'sf.action')!;
  assert.equal(node.config.action, 'flow:SvcCopilotTmpl__CloseCase');
  assert.deepEqual(JSON.parse(String(node.config.inputs)), { caseId: '{{sf_get_1.record.Id}}' });
  assert.ok(compilePlan(plan({ steps: [step({ action: 'run_action', org_action: 'nonsense' })] })).errors.length > 0);
});

test('sf.action runs the org action with rendered inputs, and only describes it in preview', async () => {
  const calls: unknown[] = [];
  const env = {
    sf: { runAction: async (kind: string, name: string, inputs: unknown) => { calls.push({ kind, name, inputs }); return { done: 'yes' }; } },
    llm: {},
  } as unknown as Env;
  const { EXECUTORS } = await import('../engine/nodes.js');
  const node = { id: 'a', type: 'sf.action', position: { x: 0, y: 0 }, config: { action: 'flow:Close_Case', inputs: '{"caseId":"{{trigger.recordId}}"}' } };
  const out = await EXECUTORS['sf.action'](node, { trigger: { recordId: '500X' } }, env);
  assert.deepEqual(out.output, { success: true, done: 'yes' });
  assert.deepEqual(calls, [{ kind: 'flow', name: 'Close_Case', inputs: { caseId: '500X' } }]);
  const dry = await EXECUTORS['sf.action'](node, { trigger: { recordId: '500X' } }, { ...env, dryRun: true });
  assert.equal(dry.output.wouldDo, 'Run Flow Close_Case');
  assert.equal(calls.length, 1);
});
