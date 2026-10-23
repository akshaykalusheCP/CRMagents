import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { validateWorkflow } from '@crmagents/shared';
import { compilePlan } from '../builder/compile.js';
import { pool } from '../db.js';
import { addDocument, deleteDocument } from '../knowledge/store.js';
import { execute, newState } from './executor.js';
import type { Env } from './nodes.js';
import { fieldGuide, planSummary, validatePlan } from './playbook.js';

after(() => pool.end());

const FIELDS = [
  { name: 'Status', label: 'Status', type: 'picklist', updateable: true, picklistValues: [{ value: 'New', active: true }, { value: 'Escalated', active: true }, { value: 'Closed', active: true }] },
  { name: 'Priority', label: 'Priority', type: 'picklist', updateable: true, picklistValues: [{ value: 'Low', active: true }, { value: 'High', active: true }] },
  { name: 'CaseNumber', label: 'Case Number', type: 'string', updateable: false },
  { name: 'OwnerId', label: 'Owner', type: 'reference', updateable: true },
];

test('playbook plan: only real, changeable fields with allowed values; no-ops dropped; reasons kept', () => {
  const { actions, dropped } = validatePlan({
    actions: [
      { kind: 'update', fields: [{ field: 'status', value: 'Escalated' }, { field: 'Priority', value: 'Urgent' }, { field: 'CaseNumber', value: '1' }, { field: 'Nope__c', value: 'x' }, { field: 'OwnerId', value: '005x' }], reason: 'Step 2' },
      { kind: 'update', fields: [{ field: 'Priority', value: 'High' }], reason: 'already' },
      { kind: 'task', fields: [], subject: 'Call the customer within 1 hour', description: 'Per step 3', reason: 'Step 3' },
      { kind: 'task', fields: [], subject: '', description: '', reason: 'empty' },
    ],
  }, FIELDS, { Status: 'New', Priority: 'High' });
  assert.deepEqual(actions[0], { kind: 'update', fields: { Status: 'Escalated' }, reason: 'Step 2' });
  assert.equal(actions[1].kind, 'task');
  assert.equal(actions.length, 2, 'the no-op Priority update is dropped');
  assert.equal(dropped.length, 5);
  assert.ok(dropped.some((d) => /"Urgent" isn't an allowed value/.test(d)));
  assert.ok(dropped.some((d) => /Owner: can't be changed/.test(d)));
  assert.match(fieldGuide(FIELDS as never), /Status \(Status, picklist: New \| Escalated \| Closed\)/);
  assert.doesNotMatch(fieldGuide(FIELDS as never), /OwnerId|CaseNumber/);
  const sum = planSummary('Printer guide — Offline', actions, 'Case', ['Check the cable'], dropped);
  assert.match(sum, /Update the Case: Status → Escalated {2}\(Step 2\)/);
  assert.match(sum, /For a person to do:\n- Check the cable/);
});

test('a follow_playbook agent: finds the procedure, waits for approval, then applies exactly the plan', async () => {
  const { rows } = await pool.query('select id from accounts limit 1');
  if (!rows[0]) return;
  const accountId = rows[0].id as string;
  const doc = await addDocument(accountId, { title: 'ZZ Printer escalation playbook', kind: 'text', text: '## Printer offline for the whole office\n\nSet the case Status to Escalated and Priority to High. Create a task "Call the customer within 1 hour". Then check the network switch.' });
  try {
    const plan = {
      name: 'Follow our playbooks', trigger_kind: 'record' as const, trigger_object: 'Case', trigger_event: 'created' as const, changed_fields: [],
      schedule: { every: 'day' as const, at: '' }, conditions: [], require_approval: true, questions: [],
      steps: [{ action: 'follow_playbook' as const, instruction: '{record.Subject} {record.Description}', input_fields: [], categories: [], outputs: [], object: '', fields: [], subject: '', message: '', where: '', limit: 0, only_if: { value: '', operator: 'equals' as const, compare: '' }, per_record: false }],
    };
    const c = compilePlan(plan as never);
    assert.deepEqual(c.errors, []);
    validateWorkflow(c.workflow);
    assert.deepEqual(c.workflow.nodes.map((n) => n.type).filter((t) => t !== 'util.output'),
      ['trigger.salesforce', 'sf.getRecord', 'knowledge.playbook', 'logic.branch', 'logic.approval', 'crm.applyActions']);

    const writes: { op: string; object: string; fields: Record<string, unknown> }[] = [];
    let prompt = '';
    const env = {
      sf: {
        accountId,
        getRecord: async () => ({ Id: '500X', Subject: 'Printer offline whole office', Description: 'Nobody can print', Status: 'New', Priority: 'Low', OwnerId: '005OWNER00000000' }),
        describe: async () => FIELDS,
        updateRecord: async (object: string, _id: string, fields: Record<string, unknown>) => { writes.push({ op: 'update', object, fields }); },
        createRecord: async (object: string, fields: Record<string, unknown>) => { writes.push({ op: 'create', object, fields }); return { id: '00T1' }; },
      },
      llm: {
        complete: async (o: { prompt: string }) => {
          prompt = o.prompt;
          return { text: JSON.stringify({ matched: true, procedure: 'ZZ Printer escalation playbook — Printer offline for the whole office', actions: [
            { kind: 'update', fields: [{ field: 'Status', value: 'Escalated' }, { field: 'Priority', value: 'High' }], subject: '', description: '', reason: 'Set Status to Escalated and Priority to High' },
            { kind: 'task', fields: [], subject: 'Call the customer within 1 hour', description: '', reason: 'Create a task' },
          ], manual_steps: ['Check the network switch'] }), usage: { input: 1, cacheWrite: 0, cacheRead: 0, output: 1, costUsd: 0 }, trace: [] };
        },
        agent: async () => { throw new Error('x'); },
      },
    } as unknown as Env;
    const st = newState({ recordId: '500X', objectApiName: 'Case' });
    let out = await execute(c.workflow, env, st);
    assert.equal(out.status, 'waiting', 'nothing is changed before the approval');
    assert.equal(writes.length, 0);
    assert.match(prompt, /Printer offline for the whole office/, 'the procedure text reached the AI');
    const waiting = st.steps.find((s) => s.status === 'waiting')!;
    assert.match(String((waiting.output as { message: string }).message), /Status → Escalated, Priority → High/);
    assert.match(String((waiting.output as { message: string }).message), /Check the network switch/);
    st.decision = { nodeId: st.pending!, approve: true };
    out = await execute(c.workflow, env, st);
    assert.equal(out.status, 'done');
    assert.deepEqual(writes[0], { op: 'update', object: 'Case', fields: { Status: 'Escalated', Priority: 'High' } });
    assert.equal(writes[1].object, 'Task');
    assert.equal(writes[1].fields.Subject, 'Call the customer within 1 hour');
    assert.equal(writes[1].fields.WhatId, '500X');
    assert.equal(writes[1].fields.OwnerId, '005OWNER00000000');
  } finally {
    await deleteDocument(accountId, doc.id).catch(() => undefined);
  }
});
