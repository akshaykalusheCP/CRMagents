import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { pool } from '../db.js';
import { encrypt } from '../crypto.js';
import { newState } from '../engine/executor.js';
import { decideFromSlack, slackApprovalBlocks, slackDecidedBlocks, teamsApprovalCard, teamsWebhookOk, verifySlackSignature } from './chatApprovals.js';

test('Slack signatures: valid, tampered, wrong secret, and too old', () => {
  const secret = 'sig_secret', body = 'payload=%7B%7D', ts = '1792300000';
  const sig = `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`;
  const now = 1792300000 * 1000 + 30_000;
  assert.equal(verifySlackSignature(secret, ts, body, sig, now), true);
  assert.equal(verifySlackSignature(secret, ts, body + 'x', sig, now), false);
  assert.equal(verifySlackSignature('other', ts, body, sig, now), false);
  assert.equal(verifySlackSignature(secret, ts, body, sig, now + 10 * 60_000), false, 'replays older than 5 minutes are refused');
  assert.equal(verifySlackSignature('', ts, body, sig, now), false, 'no signing secret: nothing is trusted');
});

test('Teams: only Microsoft webhook addresses', () => {
  assert.equal(teamsWebhookOk('https://prod-12.westus.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?sig=x'), true);
  assert.equal(teamsWebhookOk('https://acme.webhook.office.com/webhookb2/abc'), true);
  assert.equal(teamsWebhookOk('http://acme.webhook.office.com/x'), false);
  assert.equal(teamsWebhookOk('https://evil.example/webhook.office.com'), false);
  assert.equal(teamsWebhookOk('https://webhook.office.com.evil.example/x'), false);
});

test('approval messages: escaped text, buttons carry the run, decided message has none', () => {
  const a = { runId: '11111111-1111-1111-1111-111111111111', agent: 'Case <triage>', question: 'Set priority & owner?', changes: ['Priority: Medium → High'], assignedLabel: 'Support leads', recordUrl: 'https://acme.my.salesforce.com/500xx0000001' };
  const s = JSON.stringify(slackApprovalBlocks(a));
  assert.ok(s.includes('Case &lt;triage&gt;') && s.includes('priority &amp; owner'));
  assert.ok(s.includes('"action_id":"approve"') && s.includes('"action_id":"reject"') && s.includes(`"value":"${a.runId}"`));
  const d = JSON.stringify(slackDecidedBlocks(a, true, 'ana@acme.example', 'in Slack'));
  assert.ok(d.includes('Approved') && d.includes('ana@acme.example') && !d.includes('"action_id":"approve"'));
  const t = JSON.stringify(teamsApprovalCard(a));
  assert.ok(t.includes('Action.OpenUrl') && t.includes(`run=${a.runId}`) && !t.includes('Action.Submit'));
});

test('Slack clicks: only people in the workspace, the right Slack team, and the usual approval rules', async () => {
  const realFetch = globalThis.fetch;
  const told: string[] = [];
  let slackEmail = 'approver@acme.example';
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/users.info')) return new Response(JSON.stringify({ ok: true, user: { profile: { email: slackEmail } } }));
    if (u.startsWith('https://hooks.slack.com/')) { told.push(JSON.parse(String(init?.body)).text); return new Response('ok'); }
    return new Response(JSON.stringify({ ok: true }));
  }) as typeof fetch;
  const { rows: acc } = await pool.query("insert into accounts (name, plan) values ('slack-test','pro') returning id");
  const a = acc[0].id as string;
  try {
    const t = (await pool.query("insert into tenants (account_id, sf_org_id, sf_instance_url, refresh_token_enc, setup_status) values ($1,'00DSLACK00000001','https://slack-test.my.salesforce.com',$2,'ready') returning id", [a, encrypt('x')])).rows[0].id;
    await pool.query("insert into users (account_id, email, password_hash, role) values ($1,'starter@acme.example','x','builder'), ($1,'approver@acme.example','x','approver')", [a]);
    await pool.query("insert into approval_channels (account_id, kind, team_id, channel_id, secret_enc) values ($1,'slack','T_SLACK_TEST','C1',$2)", [a, encrypt('xoxb-test')]);
    const st = { ...newState({}), pending: 'approve1' };
    const graph = { nodes: [], edges: [] };
    const run = async (startedBy: string) => (await pool.query("insert into runs (tenant_id, status, started_by, state) values ($1,'waiting',$2,$3) returning id", [t, startedBy, JSON.stringify({ st, graph })])).rows[0].id as string;
    const click = (runId: string, approve: boolean, team = 'T_SLACK_TEST') => decideFromSlack({ type: 'block_actions', team: { id: team }, user: { id: 'U1' }, response_url: 'https://hooks.slack.com/actions/x', actions: [{ action_id: approve ? 'approve' : 'reject', value: runId }] }, approve, runId);
    const status = async (id: string) => (await pool.query('select status, decided_by from runs where id=$1', [id])).rows[0];

    const r1 = await run('starter@acme.example');
    await click(r1, true, 'T_OTHER_TEAM');
    assert.equal((await status(r1)).status, 'waiting', 'a click from another Slack team does nothing');
    slackEmail = 'stranger@elsewhere.example';
    await click(r1, true);
    assert.equal((await status(r1)).status, 'waiting', "someone who isn't in the workspace can't approve");
    assert.match(told.at(-1)!, /isn't in this CRMagents workspace/);

    slackEmail = 'starter@acme.example';
    await click(r1, true);
    assert.equal((await status(r1)).status, 'waiting', 'whoever started the run can\'t approve it (separation of duties)');
    assert.match(told.at(-1)!, /someone else needs to approve/);

    slackEmail = 'approver@acme.example';
    await click(r1, true);
    const s = await status(r1);
    assert.notEqual(s.status, 'waiting');
    assert.equal(s.decided_by, 'approver@acme.example');

    await click(r1, false);
    assert.match(told.at(-1)!, /not waiting|already decided/i, 'a second click on a decided run is refused');
    await new Promise((r) => setTimeout(r, 300)); // the run carries on in the background
  } finally {
    globalThis.fetch = realFetch;
    await pool.query('delete from accounts where id=$1', [a]);
    await pool.end();
  }
});
