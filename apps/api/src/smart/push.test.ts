import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { pool } from '../db.js';
import { flowStart } from '../salesforce/deploy.js';
import { pushChannel, pushJob } from './stream.js';

after(() => pool.end());

test('push events: channel per package, payload read with or without the namespace prefix', () => {
  assert.equal(pushChannel(''), '/event/CRMagents_Change__e');
  assert.equal(pushChannel('nimbus'), '/event/nimbus__CRMagents_Change__e');
  const wf = '11111111-2222-3333-4444-555555555555';
  assert.deepEqual(pushJob({ Workflow_Id__c: wf, Record_Id__c: '500000000000001AAA', Object__c: 'Case', CreatedDate: '2026-10-24T10:00:00Z' }),
    { workflowId: wf, recordId: '500000000000001AAA', object: 'Case', at: '2026-10-24T10:00:00Z' });
  assert.equal(pushJob({ nimbus__Workflow_Id__c: wf, nimbus__Record_Id__c: '500000000000001', nimbus__Object__c: 'Case' })?.recordId, '500000000000001');
  assert.equal(pushJob({ Workflow_Id__c: 'nope', Record_Id__c: '500000000000001' }), null);
  assert.equal(pushJob({ Workflow_Id__c: wf, Record_Id__c: "x'; drop" }), null);
});

test('push Flow: publishing runs in the save itself (no async path), callouts stay on the async path', () => {
  const ev = flowStart('Case', 'created', [], '005ME', true) as Record<string, unknown>;
  assert.deepEqual(ev.connector, { targetReference: 'Publish_Change' });
  assert.equal(ev.scheduledPaths, undefined);
  const old = flowStart('Case', 'created', [], '005ME') as Record<string, unknown>;
  assert.equal(old.connector, undefined);
  assert.deepEqual(old.scheduledPaths, [{ connector: { targetReference: 'Run_CRMagents' }, pathType: 'AsyncAfterCommit' }]);
});

test('push events: an event for a record whose run already started (checks covered it) does not start it again', async () => {
  const { rows } = await pool.query("select w.id, w.tenant_id from workflows w limit 1");
  if (!rows[0]) return;
  const { OrgStream } = await import('./stream.js') as unknown as { OrgStream: new (t: string, e: (m: string) => void) => { handlePush: (c: string, p: Record<string, unknown>, r?: number) => Promise<void> } };
  if (!OrgStream) return;
  const w = rows[0];
  const live = await pool.query('select live from workflows where id=$1', [w.id]);
  await pool.query('update workflows set live=true where id=$1', [w.id]);
  const run = await pool.query("insert into runs (tenant_id, workflow_id, input, status) values ($1,$2,$3,'done') returning id, created_at", [w.tenant_id, w.id, JSON.stringify({ recordId: '500PUSHTEST00001' })]);
  try {
    const before = (await pool.query('select count(*)::int n from runs where workflow_id=$1', [w.id])).rows[0].n;
    const s = new OrgStream(w.tenant_id, () => {});
    await s.handlePush('/event/CRMagents_Change__e', { Workflow_Id__c: w.id, Record_Id__c: '500PUSHTEST00001', Object__c: 'Case', CreatedDate: new Date(Date.parse(run.rows[0].created_at) - 1000).toISOString() });
    const after = (await pool.query('select count(*)::int n from runs where workflow_id=$1', [w.id])).rows[0].n;
    assert.equal(after, before, 'no second run');
  } finally {
    await pool.query('delete from runs where id=$1', [run.rows[0].id]);
    await pool.query('update workflows set live=$2 where id=$1', [w.id, live.rows[0].live]);
  }
});
