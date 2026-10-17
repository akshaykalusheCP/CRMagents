import assert from 'node:assert/strict';
import { test } from 'node:test';
import { restorePlan } from './undo.js';

test('undo: puts back only fields still holding the agent value; a person\'s later edit wins', () => {
  const before = { Status: 'New', Priority: 'Low', Phone: null, Due__c: '2026-10-01' };
  const after = { Status: 'Escalated', Priority: 'High', Phone: '+1 555', Due__c: '2026-10-20T10:00:00Z' };
  const now = { Status: 'Escalated', Priority: 'Medium', Phone: '+1 555', Due__c: '2026-10-20T10:00:00.000+0000' };
  const p = restorePlan(before, after, now);
  assert.deepEqual(p.restore, { Status: 'New', Phone: null, Due__c: '2026-10-01' });
  assert.deepEqual(p.skipped, ['Priority']);
});

test('undo: fields already back, and numbers sent as text, are handled', () => {
  const p = restorePlan({ Amount: 100, Stage: 'Open' }, { Amount: '250', Stage: 'Won' }, { Amount: 250, Stage: 'Open' });
  assert.deepEqual(p.restore, { Amount: 100 });
  assert.deepEqual(p.skipped, []);
});
