import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agreement, rank } from './discover.js';

test('discover: opportunities are ranked by hours a month; nothing found means nothing shown', () => {
  const r = rank([
    { id: 'case-triage', n: 300, minutes: 2, evidence: 'x' },
    { id: 'email-replies', n: 120, minutes: 6, evidence: 'y' },
    { id: 'duplicates', n: 0, minutes: 4, evidence: 'z' },
  ], 30);
  assert.deepEqual(r.map((o) => o.id), ['email-replies', 'case-triage']);
  assert.equal(r[0].hoursPerMonth, 12);
  assert.equal(r[0].valuePerMonth, 360);
  assert.ok(r[1].request.length > 20 && r[1].compareFields?.includes('Priority'));
});

test('discover: agreement counts only fields the team set, case-insensitive', () => {
  const a = agreement(
    [{ recordId: '500AAAAAAAAAAAAAAA', proposed: { Priority: 'High', Type: 'Problem' } }, { recordId: '500BBBBBBBBBBBBBBB', proposed: { Priority: 'low' } }],
    new Map([['500AAAAAAAAAAAA', { Priority: 'High', Type: null }], ['500BBBBBBBBBBBB', { Priority: 'Medium' }]]),
    ['Priority', 'Type'],
  );
  assert.equal(a.checked, 2);
  assert.equal(a.matched, 1);
  assert.equal(a.rate, 0.5);
});
