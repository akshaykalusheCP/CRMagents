import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { pool } from '../db.js';
import { normalizeConfig, selfServiceExec, selfServicePrompt, selfServiceTools } from './selfService.js';

const ids: { account?: string; tenant?: string; agent?: string } = {};
after(async () => {
  if (ids.tenant) await pool.query('delete from tenants where id=$1', [ids.tenant]);
  if (ids.account) await pool.query('delete from accounts where id=$1', [ids.account]);
  await pool.end();
});

test('config: odd names are dropped; tools and prompt follow the config', () => {
  const c = normalizeConfig({
    verify: true,
    records: [{ object: 'Case', label: 'Your cases', match: 'contact', fields: ['CaseNumber', 'Status; DROP'] }, { object: 'Bad Object', match: 'contact' }],
    actions: [{ key: 'flow:Start_Return', label: 'Start a return' }, { key: 'rm -rf', label: 'x' }],
    updatable: ['Phone', 'Email__c', 'Owner Id'],
  });
  assert.deepEqual(c.records.map((r) => [r.object, r.fields]), [['Case', ['CaseNumber']]]);
  assert.deepEqual(c.actions.map((a) => a.key), ['flow:Start_Return']);
  assert.deepEqual(c.updatable, ['Phone', 'Email__c']);
  assert.deepEqual(selfServiceTools(c), ['send_code', 'verify_code', 'my_records', 'update_my_details', 'run_customer_action', 'talk_to_person']);
  assert.deepEqual(selfServiceTools(normalizeConfig({ verify: false, handoff: false })), []);
  assert.match(selfServicePrompt(c), /Never show or change anything about a visitor before verify_code succeeds/);
});

test('self-service: code by email, wrong code refused, then only the visitor\'s own data', async () => {
  ids.account = (await pool.query("insert into accounts (name) values ('Acme Support') returning id")).rows[0].id;
  ids.tenant = (await pool.query("insert into tenants (sf_org_id, sf_instance_url, refresh_token_enc, account_id) values ($1,'https://x.my.salesforce.com','x',$2) returning id", [`00Dss${Date.now()}`, ids.account])).rows[0].id;
  ids.agent = (await pool.query("insert into agents (tenant_id, name) values ($1,'Help') returning id", [ids.tenant])).rows[0].id;

  const calls: { kind: string; args: any[] }[] = [];
  let lastEmail = '';
  const sf: any = {
    runAction: async (k: string, n: string, inputs: any) => { calls.push({ kind: 'action', args: [k, n, inputs] }); if (n === 'emailSimple') lastEmail = inputs.emailBody; return { ok: true }; },
    query: async (soql: string) => {
      calls.push({ kind: 'query', args: [soql] });
      if (soql.includes('FROM Contact')) return { totalSize: 1, records: [{ Id: '003ANA', AccountId: '001ACME', FirstName: 'Ana' }] };
      return { totalSize: 1, records: [{ Id: '500X', CaseNumber: '00001001', Status: 'New' }] };
    },
    updateRecord: async (...a: any[]) => { calls.push({ kind: 'update', args: a }); },
    createRecord: async (...a: any[]) => { calls.push({ kind: 'create', args: a }); return { id: '500NEW' }; },
    getRecord: async () => ({ CaseNumber: '00001050' }),
  };
  const config = normalizeConfig({
    verify: true,
    records: [{ object: 'Case', label: 'Your cases', match: 'contact', fields: ['CaseNumber', 'Status'] }],
    actions: [{ key: 'flow:Start_Return', label: 'Start a return' }],
    updatable: ['Phone'],
  });
  const sessionId = randomUUID();
  const exec = selfServiceExec({ agentId: ids.agent!, sessionId, config, sf: async () => sf, transcript: 'Visitor: I need help', companyName: 'Acme Support' });
  const run = (name: string, input: unknown) => exec(name, input)!;

  // Nothing about the visitor before verifying, whatever they claim.
  await assert.rejects(run('my_records', { kind: 'Your cases' }), /not verified/);
  assert.equal(exec('search_knowledge', {}), undefined); // other tools run normally

  assert.match(String(await run('send_code', { email: 'Ana@Example.com' })), /Code sent to a•••@example\.com/);
  const code = /code is (\d{6})/.exec(lastEmail)![1];
  await assert.rejects(run('verify_code', { code: code === '000000' ? '111111' : '000000' }), /not right/);
  assert.match(String(await run('verify_code', { code })), /Verified\. The visitor is Ana/);

  const recs: any = await run('my_records', { kind: 'your cases' });
  assert.deepEqual(recs['Your cases'], [{ CaseNumber: '00001001', Status: 'New' }]);
  assert.match(calls.filter((c) => c.kind === 'query').at(-1)!.args[0], /FROM Case WHERE ContactId = '003ANA'/);

  assert.match(String(await run('update_my_details', { fields: { Phone: '+91 98450 12345', OwnerId: '005EVIL' } })), /Updated Phone\. Not changed \(not allowed here\): OwnerId/);
  assert.deepEqual(calls.find((c) => c.kind === 'update')!.args, ['Contact', '003ANA', { Phone: '+91 98450 12345' }]);

  // Identity comes from the session, not from what the AI passes.
  await run('run_customer_action', { action: 'flow:Start_Return', inputs: { orderNumber: '42', contactId: '003SOMEONEELSE' } });
  const act = calls.filter((c) => c.kind === 'action').at(-1)!.args;
  assert.deepEqual([act[0], act[1], act[2].contactId, act[2].accountId, act[2].orderNumber], ['flow', 'Start_Return', '003ANA', '001ACME', '42']);
  await assert.rejects(run('run_customer_action', { action: 'flow:Delete_Everything' }), /isn't available/);

  assert.match(String(await run('talk_to_person', { summary: 'Refund question' })), /Case number 00001050/);
  const c = calls.find((x) => x.kind === 'create')!.args;
  assert.equal(c[1].ContactId, '003ANA');
  assert.match(c[1].Description, /Email verified in chat\.\n\nVisitor: I need help/);
});

test('self-service: too many wrong codes locks verification', async () => {
  const sf: any = { runAction: async () => ({}), query: async () => ({ records: [] }) };
  const exec = selfServiceExec({ agentId: ids.agent!, sessionId: randomUUID(), config: normalizeConfig({ verify: true }), sf: async () => sf, transcript: '', companyName: 'Acme' });
  await exec('send_code', { email: 'bob@example.com' });
  for (let i = 0; i < 5; i++) await assert.rejects(exec('verify_code', { code: 'abcdef' })!, /not right/);
  await assert.rejects(exec('verify_code', { code: '123456' })!, /Too many wrong codes/);
});
