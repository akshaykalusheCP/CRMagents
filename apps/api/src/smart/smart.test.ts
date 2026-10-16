import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateWorkflow, type Workflow } from '@crmagents/shared';
import { covered, DETECTORS } from './suggest.js';
import { extrapolate, spread } from './backtest.js';
import { assess, AUTONOMY_MIN, removeApproval } from './trust.js';
import { knownFailure } from './repair.js';
import { conflicts, type OrgAutomation } from './orgAutomation.js';
import { localTime, violates, type Rule } from './policies.js';
import { outcomeOf } from './regress.js';
import { changeEventFor, routeEvent } from './stream.js';

const n = (id: string, type: string, config: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, config });
const e = (source: string, target: string, sourceHandle = 'out') => ({ id: `${source}->${target}:${sourceHandle}`, source, target, sourceHandle });

test('suggestions: an agent on the same object that already acts covers the finding', () => {
  const stale = DETECTORS.find((d) => d.key === 'stale_deals')!;
  const g: Workflow = { nodes: [n('t', 'trigger.schedule'), n('q', 'sf.query', { soql: 'SELECT Id FROM Opportunity' }), n('k', 'sf.createTask')], edges: [] };
  assert.equal(covered(stale, [g]), true);
  assert.equal(covered(stale, [{ nodes: [n('t', 'trigger.salesforce', { objectApiName: 'Case' }), n('k', 'sf.createTask')], edges: [] }]), false);
  assert.equal(covered(stale, []), false);
});

test('replay: samples spread across the period and scale to the full month', () => {
  assert.deepEqual(spread([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5), [1, 3, 5, 7, 9]);
  assert.deepEqual(spread([1, 2], 5), [1, 2]);
  const rows = [
    { status: 'done' as const, costUsd: 0.001, wouldDo: [{ action: 'Ask for approval', detail: '' }, { action: 'Create Task', detail: '' }] },
    { status: 'done' as const, costUsd: 0.001, wouldDo: [{ action: 'Update Case 500gL000001AbcdQAC', detail: '' }] },
    { status: 'done' as const, costUsd: 0.001, wouldDo: [] },
    { status: 'error' as const, costUsd: 0, wouldDo: [] },
  ];
  const x = extrapolate(rows, 400);
  assert.equal(x.acted, 2); assert.equal(x.skipped, 1); assert.equal(x.failed, 1);
  assert.deepEqual(x.actions, [{ action: 'Create Task', count: 100 }, { action: 'Update Case', count: 100 }]);
  assert.ok(Math.abs(x.estCostUsd - 0.3) < 1e-9);
});

const run = (status: string, approved?: boolean, note?: string) => ({
  status, output: status === 'error' ? 'REQUIRED_FIELD_MISSING' : 'ok', decision_note: note ?? null, created_at: new Date().toISOString(),
  steps: approved === undefined ? [] : [{ type: 'logic.approval', status: 'ok', output: { approved } }],
});

test('trust: long approval streaks earn autonomy; rejections and failures get flagged', () => {
  const good = assess('w', Array.from({ length: AUTONOMY_MIN }, () => run('done', true)), true);
  assert.equal(good.suggestion?.kind, 'drop_approval');
  assert.equal(assess('w', Array.from({ length: AUTONOMY_MIN }, () => run('done', true)), false).suggestion, undefined); // no approval to drop
  const mixed = assess('w', [run('done', false, 'wrong category'), run('done', true), run('done', false), run('done', true), run('done', false)], true);
  assert.equal(mixed.suggestion?.kind, 'review');
  assert.match(mixed.suggestion!.detail, /wrong category/);
  const failing = assess('w', [run('error'), run('error'), run('error'), run('done')], false);
  assert.equal(failing.suggestion?.kind, 'fix');
  assert.equal(assess('w', [run('done', true)], true).suggestion, undefined); // too little evidence
});

test('trust: removing approval rewires approved steps and drops the "not approved" exit', () => {
  const g: Workflow = {
    nodes: [n('t', 'trigger.salesforce', { objectApiName: 'Case' }), n('b', 'logic.branch'), n('a', 'logic.approval'), n('w', 'sf.createTask'), n('r', 'util.output'), n('o', 'util.output')],
    edges: [e('t', 'b'), e('b', 'a', 'true'), e('a', 'w', 'approved'), e('a', 'r', 'rejected'), e('w', 'o')],
  };
  const out = removeApproval(g);
  validateWorkflow(out);
  assert.deepEqual(out.nodes.map((x) => x.id), ['t', 'b', 'w', 'o']);
  assert.ok(out.edges.some((x) => x.source === 'b' && x.target === 'w' && x.sourceHandle === 'true'));
  assert.ok(!out.edges.some((x) => x.source === 'a' || x.target === 'a'));
});

test('repair: common failures are explained without AI', () => {
  assert.equal(knownFailure('invalid_grant: expired access/refresh token')?.action, 'reconnect');
  assert.equal(knownFailure('Daily AI budget of $2.00 reached')?.action, 'settings');
  assert.equal(knownFailure('INSUFFICIENT_ACCESS_OR_READONLY')?.action, 'data');
  assert.equal(knownFailure('REQUIRED_FIELD_MISSING: Subject'), null);
});

test('org automation: warns about Flows and triggers on the records an agent writes', () => {
  const a: OrgAutomation = {
    flows: [
      { name: 'Case_Assign', label: 'Case Assignment', object: 'Case', event: 'created or updated', timing: 'after save' },
      { name: 'Lead_X', label: 'Lead X', object: 'Lead', event: 'created', timing: 'before save' },
    ],
    triggers: [{ name: 'CaseTrigger', object: 'Case' }],
    rules: [],
  };
  const g: Workflow = { nodes: [n('t', 'trigger.salesforce', { objectApiName: 'Case', event: 'created or updated' }), n('u', 'sf.updateRecord', { sobject: 'Case' })], edges: [] };
  const w = conflicts(g, a);
  assert.ok(w.some((x) => /Case Assignment/.test(x)));
  assert.ok(w.some((x) => /Apex trigger/.test(x)));
  assert.ok(w.some((x) => /also updates it/.test(x)));
  assert.deepEqual(conflicts({ nodes: [n('t', 'trigger.manual'), n('q', 'sf.query')], edges: [] }, a), []);
});

const rule = (r: Partial<Rule>): Rule => ({ summary: 'x', actions: ['any'], objects: [], when: [], days: [], hours: null, timezone: 'UTC', ...r });

test('rules: action, object, record conditions and time windows', () => {
  const sat = new Date('2026-10-17T10:00:00Z'); // Saturday
  const mon = new Date('2026-10-19T10:00:00Z');
  const weekend = rule({ actions: ['email'], days: [0, 6] });
  assert.equal(violates(weekend, { action: 'email', object: 'emailSimple', now: sat }), true);
  assert.equal(violates(weekend, { action: 'email', object: 'emailSimple', now: mon }), false);
  assert.equal(violates(weekend, { action: 'update', object: 'Case', now: sat }), false);
  const owned = rule({ actions: ['update', 'task'], objects: ['Account'], when: [{ field: 'Owner.Name', operator: 'equals', value: 'Enterprise Team' }] });
  assert.equal(violates(owned, { action: 'update', object: 'Account', record: { Owner: { Name: 'Enterprise Team' } } }), true);
  assert.equal(violates(owned, { action: 'update', object: 'Account', record: { Owner: { Name: 'Asha' } } }), false);
  assert.equal(violates(owned, { action: 'update', object: 'Case', record: { Owner: { Name: 'Enterprise Team' } } }), false);
  const night = rule({ hours: { from: 22, to: 6 } }); // overnight window
  assert.equal(violates(night, { action: 'create', object: 'Task', now: new Date('2026-10-19T23:30:00Z') }), true);
  assert.equal(violates(night, { action: 'create', object: 'Task', now: new Date('2026-10-19T12:00:00Z') }), false);
  assert.deepEqual(localTime(new Date('2026-10-19T20:00:00Z'), 'Asia/Kolkata'), { day: 2, hour: 1 }); // Tue 01:30 IST
});

test('regression: compares AI decisions and changes, not wording', () => {
  const steps = [{ type: 'ai.classify', status: 'ok', output: { category: 'Billing' } }, { type: 'sf.createTask', status: 'ok', output: { id: '00T' } }];
  assert.equal(outcomeOf(steps, 'whatever'), 'category: Billing · changes: createTask');
  assert.equal(outcomeOf([], ' Skipped:  only runs when\\nStatus is New '), 'Skipped: only runs when\\nStatus is New');
});

test('real-time: change events start the right agents and skip our own updates', () => {
  assert.equal(changeEventFor('Case'), 'CaseChangeEvent');
  assert.equal(changeEventFor('Claim__c'), 'Claim__ChangeEvent');
  const agents = [{ id: 'a', object: 'Case', event: 'created' }, { id: 'b', object: 'Case', event: 'created or updated' }, { id: 'c', object: 'Lead', event: 'created' }];
  assert.deepEqual(routeEvent({ entityName: 'Case', changeType: 'CREATE', recordIds: ['500A'] }, agents, '005ME'), [{ workflowId: 'a', recordId: '500A' }, { workflowId: 'b', recordId: '500A' }]);
  assert.deepEqual(routeEvent({ entityName: 'Case', changeType: 'UPDATE', recordIds: ['500A'], commitUser: '005OTHER' }, agents, '005ME'), [{ workflowId: 'b', recordId: '500A' }]);
  assert.deepEqual(routeEvent({ entityName: 'Case', changeType: 'UPDATE', recordIds: ['500A'], commitUser: '005ME' }, agents, '005ME'), []); // our own write
  assert.deepEqual(routeEvent({ entityName: 'Case', changeType: 'DELETE', recordIds: ['500A'] }, agents, null), []);
});
