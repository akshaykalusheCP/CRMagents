import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fieldsChanged, isUpdate, lastSlot, pickNew, scheduleDue, triggerOf, triggersOf, tzOffset, watchQuery } from './watcher.js';
import { routeEvent } from '../smart/stream.js';
import { flowStart } from '../salesforce/deploy.js';
import { atPath } from './webhook.js';
import { referencedFields } from './admin.js';

const T0 = new Date('2026-10-08T12:00:00Z');
const at = (s: number) => new Date(T0.getTime() + s * 1000).toISOString();

test('watch query is inclusive, ordered and uses the right field', () => {
  assert.equal(watchQuery('Case', 'created', T0).soql, 'SELECT Id, CreatedDate, LastModifiedById FROM Case WHERE CreatedDate >= 2026-10-08T12:00:00Z ORDER BY CreatedDate ASC LIMIT 25');
  assert.match(watchQuery('Lead', 'created or updated', T0).soql, /SystemModstamp >= 2026-10-08T12:00:00Z ORDER BY SystemModstamp/);
});

test('trigger is read from the workflow; objects must be plain API names', () => {
  const g = (config: any) => ({ nodes: [{ id: 't', type: 'trigger.salesforce', position: { x: 0, y: 0 }, config }], edges: [] });
  assert.deepEqual(triggerOf(g({ objectApiName: 'Case' })), { object: 'Case', event: 'created', changed: [] });
  assert.deepEqual(triggerOf(g({ objectApiName: 'Lead', event: 'created or updated' })), { object: 'Lead', event: 'created or updated', changed: [] });
  assert.equal(triggerOf(g({ objectApiName: 'Case WHERE 1=1' })), null);
  // Several objects, field-change filter (ignored for "created"/"deleted").
  assert.deepEqual(triggersOf(g({ objectApiName: 'Case, Lead', event: 'updated', changedFields: 'Status, Bad Field' })).map((t) => [t.object, t.event, t.changed]),
    [['Case', 'updated', ['Status']], ['Lead', 'updated', ['Status']]]);
  assert.deepEqual(triggerOf(g({ objectApiName: 'Case', event: 'deleted', changedFields: 'Status' }))!.changed, []);
});

test('updated and deleted checks; only-when-changed compares with the last values seen', () => {
  assert.match(watchQuery('Case', 'deleted', T0).soql, /WHERE IsDeleted = true AND SystemModstamp >= /);
  assert.equal(watchQuery('Case', 'deleted', T0).deleted, true);
  assert.match(watchQuery('Case', 'updated', T0, ['Status']).soql, /^SELECT Id, SystemModstamp, LastModifiedById, CreatedDate, Status FROM Case/);
  assert.equal(isUpdate({ CreatedDate: at(0), SystemModstamp: at(1) }), false); // just created
  assert.equal(isUpdate({ CreatedDate: at(0), SystemModstamp: at(60) }), true);
  assert.equal(fieldsChanged(['Status'], { Status: 'New' }, { Status: 'Escalated' }), true);
  assert.equal(fieldsChanged(['Status'], { Status: 'New' }, { Status: 'New', Subject: 'x' }), false);
  assert.equal(fieldsChanged(['Status'], undefined, { Status: 'New' }), false); // never seen: not a known change
  assert.equal(fieldsChanged(['Status'], { Status: null }, { Status: '' }), false);
  assert.equal(fieldsChanged([], undefined, {}), true);
});

test('real-time events: updated, deleted and only-when-changed', () => {
  const agents = [
    { id: 'upd', object: 'Case', event: 'updated', changed: ['Status'] },
    { id: 'del', object: 'Case', event: 'deleted' },
    { id: 'any', object: 'Case', event: 'created or updated' },
  ];
  const ids = (h: any) => routeEvent({ entityName: 'Case', recordIds: ['500A'], ...h }, agents, '005ME').map((r) => r.workflowId);
  assert.deepEqual(ids({ changeType: 'UPDATE', changedFields: ['Status', 'LastModifiedDate'] }), ['upd', 'any']);
  assert.deepEqual(ids({ changeType: 'UPDATE', changedFields: ['Subject'] }), ['any']);
  assert.deepEqual(ids({ changeType: 'DELETE' }), ['del']);
  assert.deepEqual(ids({ changeType: 'CREATE' }), ['any']);
  assert.deepEqual(ids({ changeType: 'UPDATE', changedFields: ['Status'], commitUser: '005ME' }), []); // our own change
});

test('schedules run in their time zone', () => {
  assert.equal(tzOffset(new Date('2026-10-16T00:00:00Z'), 'Asia/Kolkata'), 330);
  // 08:00 in Kolkata is 02:30 UTC.
  assert.equal(lastSlot('day', '08:00', new Date('2026-10-16T05:00:00Z'), 'Asia/Kolkata').toISOString(), '2026-10-16T02:30:00.000Z');
  assert.equal(lastSlot('day', '08:00', new Date('2026-10-16T02:00:00Z'), 'Asia/Kolkata').toISOString(), '2026-10-15T02:30:00.000Z');
  // New York in summer (UTC-4) and winter (UTC-5).
  assert.equal(lastSlot('day', '09:00', new Date('2026-07-01T20:00:00Z'), 'America/New_York').toISOString(), '2026-07-01T13:00:00.000Z');
  assert.equal(lastSlot('day', '09:00', new Date('2026-12-01T20:00:00Z'), 'America/New_York').toISOString(), '2026-12-01T14:00:00.000Z');
  assert.equal(lastSlot('day', '08:00', new Date('2026-10-16T09:00:00Z'), 'Not/AZone').toISOString(), '2026-10-16T08:00:00.000Z');
});

test('push-from-Salesforce Flow: start conditions', () => {
  const s = flowStart('Case', 'updated', ['Status', 'Priority'], '005ME');
  assert.equal(s.recordTriggerType, 'Update');
  assert.equal(s.filterLogic, '(1 OR 2) AND 3');
  assert.deepEqual(s.filters!.map((f) => [f.field, f.operator]), [['Status', 'IsChanged'], ['Priority', 'IsChanged'], ['LastModifiedById', 'NotEqualTo']]);
  const c = flowStart('Lead', 'created', [], '005ME');
  assert.equal(c.recordTriggerType, 'Create');
  assert.equal(c.filters, undefined);
  assert.equal(flowStart('Lead', 'created or updated', ['Status'], '005ME').filterLogic, 'and'); // "is changed" only for updates
});

test('webhook body paths and the fields an agent needs in another org', () => {
  assert.equal(atPath({ ticket: { caseId: '500A' } }, 'ticket.caseId'), '500A');
  assert.equal(atPath({ a: 1 }, 'b.c'), undefined);
  const f = referencedFields({
    nodes: [
      { id: 't', type: 'trigger.salesforce', position: { x: 0, y: 0 }, config: { objectApiName: 'Case', changedFields: 'Status' } },
      { id: 'g', type: 'sf.getRecord', position: { x: 0, y: 0 }, config: { sobject: 'Case', fields: 'Subject, Reason__c' } },
      { id: 'u', type: 'sf.updateRecord', position: { x: 0, y: 0 }, config: { sobject: 'Account', fields: '{"Rating":"Hot"}' } },
      { id: 'q', type: 'sf.query', position: { x: 0, y: 0 }, config: { soql: 'SELECT Id, Name, Owner.Name FROM Lead' } },
    ],
    edges: [],
  });
  assert.deepEqual([...f.get('Case')!], ['Status', 'Subject', 'Reason__c']);
  assert.deepEqual([...f.get('Account')!], ['Rating']);
  assert.deepEqual([...f.get('Lead')!], ['Id', 'Name']);
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
