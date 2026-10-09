import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lastSlot, pickNew, scheduleDue, triggerOf, watchQuery } from './watcher.js';

const T0 = new Date('2026-10-08T12:00:00Z');
const at = (s: number) => new Date(T0.getTime() + s * 1000).toISOString();

test('watch query is inclusive, ordered and uses the right field', () => {
  assert.equal(watchQuery('Case', 'created', T0).soql, 'SELECT Id, CreatedDate, LastModifiedById FROM Case WHERE CreatedDate >= 2026-10-08T12:00:00Z ORDER BY CreatedDate ASC LIMIT 25');
  assert.match(watchQuery('Lead', 'created or updated', T0).soql, /SystemModstamp >= 2026-10-08T12:00:00Z ORDER BY SystemModstamp/);
});

test('trigger is read from the workflow; objects must be plain API names', () => {
  const g = (config: any) => ({ nodes: [{ id: 't', type: 'trigger.salesforce', position: { x: 0, y: 0 }, config }], edges: [] });
  assert.deepEqual(triggerOf(g({ objectApiName: 'Case' })), { object: 'Case', event: 'created' });
  assert.deepEqual(triggerOf(g({ objectApiName: 'Lead', event: 'created or updated' })), { object: 'Lead', event: 'created or updated' });
  assert.equal(triggerOf(g({ objectApiName: 'Case WHERE 1=1' })), null);
});

test('new records run once; records already seen at the cursor are skipped', () => {
  const first = pickNew([{ Id: 'a', CreatedDate: at(1) }, { Id: 'b', CreatedDate: at(2) }, { Id: 'c', CreatedDate: at(2) }], 'CreatedDate', T0, [], 'created', null);
  assert.deepEqual(first.run, ['a', 'b', 'c']);
  assert.equal(first.cursor.toISOString(), at(2));
  assert.deepEqual(first.seenAtCursor, ['b', 'c']);
  // next tick: the inclusive query returns b and c again plus a new d at the same second
  const second = pickNew([{ Id: 'b', CreatedDate: at(2) }, { Id: 'c', CreatedDate: at(2) }, { Id: 'd', CreatedDate: at(2) }], 'CreatedDate', first.cursor, first.seenAtCursor, 'created', null);
  assert.deepEqual(second.run, ['d']);
  assert.deepEqual(second.seenAtCursor, ['b', 'c', 'd']);
});

test('changes made by CRMagents itself never retrigger (no loops)', () => {
  const r = pickNew([
    { Id: 'x', SystemModstamp: at(1), LastModifiedById: '005gL000009690DQAQ' },
    { Id: 'y', SystemModstamp: at(2), LastModifiedById: '005OTHERUSER00001' },
  ], 'SystemModstamp', T0, [], 'created or updated', '005gL000009690D');
  assert.deepEqual(r.run, ['y']);
  assert.equal(r.cursor.toISOString(), at(2)); // cursor still moves past our own change
});

test('a failure part-way leaves a checkpoint so nothing is skipped or run twice', () => {
  const r = pickNew([{ Id: 'a', CreatedDate: at(1) }, { Id: 'b', CreatedDate: at(2) }], 'CreatedDate', T0, [], 'created', null);
  // if running "b" fails, saving checkpoints[1] means the next tick returns b again and runs only b
  const cp = r.checkpoints[1];
  const retry = pickNew([{ Id: 'a', CreatedDate: at(1) }, { Id: 'b', CreatedDate: at(2) }], 'CreatedDate', cp.cursor, cp.seenAtCursor, 'created', null);
  assert.deepEqual(retry.run, ['b']);
});

test('schedules: daily, hourly and weekly slots in UTC', () => {
  const now = new Date('2026-10-09T09:30:00Z'); // a Friday
  assert.equal(lastSlot('day', '08:00', now).toISOString(), '2026-10-09T08:00:00.000Z');
  assert.equal(lastSlot('day', '10:00', now).toISOString(), '2026-10-08T10:00:00.000Z');
  assert.equal(lastSlot('hour', '', now).toISOString(), '2026-10-09T09:00:00.000Z');
  assert.equal(lastSlot('week', '08:00', now).toISOString(), '2026-10-05T08:00:00.000Z'); // Monday
  // turned on at 08:30 -> not due until the next day's 08:00
  assert.equal(scheduleDue('day', '08:00', new Date('2026-10-09T08:30:00Z'), now), false);
  // last ran yesterday -> due now
  assert.equal(scheduleDue('day', '08:00', new Date('2026-10-08T08:00:05Z'), now), true);
});
