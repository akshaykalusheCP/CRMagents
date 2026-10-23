import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { compilePlan } from '../builder/compile.js';
import type { Plan, PlanStep } from '../builder/plan.js';
import { pool } from '../db.js';
import { execute, newState } from '../engine/executor.js';
import type { Env } from '../engine/nodes.js';
import { addDocument, chunkText, deleteDocument, listDocuments, searchKnowledge } from './store.js';
import { markSuggestion, recordSuggestions } from './suggestions.js';

const GUIDE = `Enterprise Network Troubleshooting Guide

WiFi connectivity

Collect user context first: location, device type, IP address, operating system and the exact error message.
Confirm whether the issue affects one SSID or all wireless networks. Forget the network and reconnect.

VPN and remote access

If the VPN client shows error 809, check that UDP ports 500 and 4500 are open on the home router.
Reinstall the VPN profile from the company portal when certificates have expired.

Printer setup

Add the printer by its queue name from the print server. Restart the spooler service if jobs are stuck.`;

test('chunking keeps each section under its heading', () => {
  const c = chunkText(GUIDE);
  const vpn = c.find((x) => x.body.includes('error 809'));
  assert.equal(vpn?.heading, 'VPN and remote access');
  assert.ok(c.every((x) => x.body.length <= 1500));
  // PDF page markers become part of the heading.
  assert.equal(chunkText('## Page 3\n\nRestart the router.')[0].heading, 'Page 3');
});

const ids: { account?: string; tenant?: string } = {};
after(async () => {
  if (ids.tenant) await pool.query('delete from tenants where id=$1', [ids.tenant]);
  if (ids.account) await pool.query('delete from accounts where id=$1', [ids.account]);
  await pool.end();
});

test('search finds the matching section and ranks it first; other accounts see nothing', async () => {
  ids.account = (await pool.query("insert into accounts (name) values ('kb-test') returning id")).rows[0].id;
  const doc = await addDocument(ids.account!, { title: 'Network Guide', kind: 'text', text: GUIDE });
  assert.ok(doc.chunks >= 3);
  const hits = await searchKnowledge(ids.account!, 'VPN keeps failing with error 809 from home');
  assert.equal(hits[0].heading, 'VPN and remote access');
  assert.match(hits[0].body, /UDP ports 500 and 4500/);
  // Only stop words: no search at all.
  assert.deepEqual(await searchKnowledge(ids.account!, 'the and of'), []);
  const other = (await pool.query("insert into accounts (name) values ('kb-other') returning id")).rows[0].id;
  assert.deepEqual(await searchKnowledge(other, 'VPN error 809'), []);
  await pool.query('delete from accounts where id=$1', [other]);
  // Limiting to a document title that doesn't exist finds nothing.
  assert.deepEqual(await searchKnowledge(ids.account!, 'VPN', 4, ['Printer manual']), []);
});

const step = (s: Partial<PlanStep> & Pick<PlanStep, 'action'>): PlanStep => ({
  instruction: '', input_fields: [], categories: [], outputs: [], object: '', fields: [], subject: '', message: '', where: '', limit: 0,
  only_if: { value: '', operator: 'equals', compare: '' }, per_record: false, ...s,
});

test('case suggestion workflow: search guides, AI writes from them, suggestion saved on the case', async () => {
  const plan: Plan = {
    name: 'Case suggestions', trigger_kind: 'record', trigger_object: 'Case', schedule: { every: 'day', at: '08:00' },
    conditions: [], require_approval: true, questions: [],
    steps: [
      step({ action: 'search_knowledge', input_fields: ['Subject', 'Description'] }),
      step({ action: 'ai_write', instruction: 'Write troubleshooting steps for this case: {record.Subject}' }),
      step({ action: 'suggest', subject: 'Suggested resolution', message: '{step2.text}' }),
    ],
  };
  const c = compilePlan(plan);
  assert.deepEqual(c.errors, []);
  // Showing a suggestion changes nothing in Salesforce: no approval step.
  assert.ok(!c.workflow.nodes.some((n) => n.type === 'logic.approval'));
  const ai = c.workflow.nodes.find((n) => n.type === 'ai.agent')!;
  assert.match(String(ai.config.prompt), /\{\{kb_1\.text\}\}/);

  ids.tenant = (await pool.query(
    "insert into tenants (sf_org_id, sf_instance_url, refresh_token_enc, account_id) values ($1,'https://x.my.salesforce.com','x',$2) returning id",
    [`00Dtest${Date.now()}`, ids.account],
  )).rows[0].id;
  let prompt = '';
  const env = {
    sf: { accountId: ids.account, getRecord: async () => ({ Subject: 'VPN error 809', Description: 'Cannot connect from home' }) },
    llm: {
      agent: async (o: { prompt: string }) => { prompt = o.prompt; return { text: 'Open UDP 500 and 4500 [1].', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0 }, trace: [] }; },
      complete: async () => { throw new Error('unused'); },
    },
    run: { tenantId: ids.tenant, runId: undefined as unknown as string },
  } as unknown as Env;
  const out = await execute(c.workflow, env, newState({ recordId: '500Qy00000AbCdEFGH', objectApiName: 'Case' }));
  assert.equal(out.status, 'done', out.error);
  assert.match(prompt, /UDP ports 500 and 4500/); // the guide reached the AI

  const saved = await recordSuggestions(ids.tenant!, '500Qy00000AbCdE'); // 15-character Id matches too
  assert.equal(saved.length, 1);
  assert.equal(saved[0].title, 'Suggested resolution');
  assert.equal(saved[0].body, 'Open UDP 500 and 4500 [1].');
  assert.equal(saved[0].sources[0].title, 'Network Guide');
  await markSuggestion(ids.tenant!, saved[0].id, 'dismissed', 'Agent@X.com');
  assert.equal((await recordSuggestions(ids.tenant!, '500Qy00000AbCdEFGH')).length, 0);

  const [d] = await listDocuments(ids.account!);
  await deleteDocument(ids.account!, d.id);
  assert.equal((await pool.query('select count(*)::int n from knowledge_chunks where doc_id=$1', [d.id])).rows[0].n, 0);
});

test('knowledge sync reads only new or changed Salesforce items and removes what is gone', async () => {
  const { plan } = await import('./sync.js');
  const have = new Map([
    ['t:a', { ids: ['d1'], version: 'v1' }],   // unchanged
    ['t:b', { ids: ['d2'], version: 'v1' }],   // new version in Salesforce
    ['t:c', { ids: ['d3'], version: 'v1' }],   // removed in Salesforce
    ['t:d', { ids: ['d4'], version: null }],   // synced before versions were kept
  ]);
  const r = plan(have, [{ ref: 't:a', version: 'v1' }, { ref: 't:b', version: 'v2' }, { ref: 't:d', version: 'v1' }, { ref: 't:e', version: 'v1' }]);
  assert.deepEqual(r.read.map((x) => x.ref).sort(), ['t:b', 't:d', 't:e']);
  assert.deepEqual(r.gone, ['d3']);
});
