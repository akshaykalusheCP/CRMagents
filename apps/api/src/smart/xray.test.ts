import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findProblems, healthScore, readFlow, triggerWrites, type Automation } from './xray.js';

test('xray: reads what a Flow and a Process Builder write', () => {
  const flow = readFlow({ start: { object: 'Case', filterFormula: 'ISNEW()' }, recordUpdates: [{ inputReference: '$Record', inputAssignments: [{ field: 'Priority', value: { stringValue: 'High' } }] }, { object: 'Account', inputAssignments: [{ field: 'Rating' }] }], recordCreates: [{ object: 'Task' }], decisions: [{ label: 'Is VIP', rules: [] }] }, '');
  assert.equal(flow.object, 'Case');
  assert.deepEqual(flow.writes, [{ object: 'Case', fields: ['Priority'] }, { object: 'Account', fields: ['Rating'] }]);
  assert.deepEqual(flow.creates, ['Task']);
  assert.equal(flow.steps, 4);
  assert.match(flow.outline!, /Priority = High/);
  const pb = readFlow({ processMetadataValues: [{ name: 'ObjectType', value: { stringValue: 'Lead' } }], recordUpdates: { inputReference: 'myVariable_current', inputAssignments: { field: 'Status' } } }, '');
  assert.deepEqual(pb.writes, [{ object: 'Lead', fields: ['Status'] }]);
});

test('xray: fields an Apex trigger sets, ignoring comparisons, comments and strings', () => {
  const f = triggerWrites(`for (Case c : Trigger.new) {\n  // c.Fake = 1;\n  if (c.Status == 'New') c.Priority = 'High';\n  c.Description = 'x.Y = z';\n}`);
  assert.deepEqual(f.sort(), ['Description', 'Priority']);
});

const a = (p: Partial<Automation>): Automation => ({ kind: 'flow', name: 'n', label: 'n', object: 'Case', event: 'created or updated', timing: 'after save', active: true, managed: false, lastModified: null, writes: [], creates: [], steps: 1, actions: [], order: null, ...p });

test('xray: same field written twice is a conflict; retired tools and crowding are flagged', () => {
  const list = [
    a({ name: 'F1', label: 'Set priority', writes: [{ object: 'Case', fields: ['Priority'] }] }),
    a({ kind: 'trigger', name: 'CaseTrigger', label: 'CaseTrigger', event: 'created', writes: [{ object: 'Case', fields: ['Priority', 'Status'] }] }),
    a({ kind: 'process', name: 'PB1', label: 'Old process', event: 'any' }),
    a({ name: 'F2', label: 'Other', order: 10 }),
    a({ name: 'F3', label: 'Deleted only', event: 'deleted', writes: [{ object: 'Case', fields: ['Status'] }] }),
  ];
  const f = findProblems(list, [{ name: 'Old', label: 'Old flow', object: 'Lead' }]);
  const conflict = f.find((x) => x.kind === 'conflict')!;
  assert.equal(conflict.title, '2 automations set Case.Priority');
  assert.ok(!f.some((x) => x.kind === 'conflict' && x.title.includes('Status')), 'a delete-only flow does not conflict with saves');
  assert.ok(f.some((x) => x.kind === 'crowded' && x.object === 'Case'));
  assert.ok(f.some((x) => x.kind === 'legacy' && x.automations[0] === 'PB1'));
  assert.ok(f.some((x) => x.kind === 'clutter'));
  assert.equal(f[0].severity, 'high');
  assert.ok(healthScore(f) < 100);
});
