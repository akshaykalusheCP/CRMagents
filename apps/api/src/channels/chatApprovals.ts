import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { roleAtLeast } from '@crmagents/shared';
import { config } from '../config.js';
import { decrypt, encrypt } from '../crypto.js';
import { pool } from '../db.js';
import { safeFetch } from '../engine/net.js';
import { decideRun } from '../engine/service.js';
import { audit } from '../trust/audit.js';

// Approvals in Slack and Microsoft Teams.
// Slack: CRMagents' Slack app is added to a channel ("Add to Slack"); each waiting run posts a message with Approve
// and Reject buttons. A click counts only when the Slack user's email belongs to someone in the workspace, and the
// usual rules apply (separation of duties, assigned approver). The message then shows who decided.
// Teams: its incoming webhooks can't take button clicks, so the card has a button that opens the approval here.
// Slack needs the platform's Slack app (SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_SIGNING_SECRET): off until set.

const env = (k: string) => process.env[k] ?? '';
export const slackAvailable = () => !!(env('SLACK_CLIENT_ID') && env('SLACK_CLIENT_SECRET') && env('SLACK_SIGNING_SECRET'));
const slackRedirect = () => `${config.publicUrl}/public/slack/oauth`;
const approvalsLink = (runId: string) => `${config.webUrl}/?tab=approvals&run=${runId}`;

/** Slack's request signature (v0, HMAC-SHA256 over "v0:timestamp:body"), within 5 minutes. Pure; tested. */
export function verifySlackSignature(secret: string, ts: string, body: string, sig: string, now = Date.now()): boolean {
  if (!secret || !ts || !sig || !/^\d+$/.test(ts) || Math.abs(now / 1000 - Number(ts)) > 300) return false;
  const want = `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`;
  const a = Buffer.from(want), b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Teams accepts posts only to Microsoft's webhook hosts. Pure; tested. */
export function teamsWebhookOk(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /(^|\.)(webhook\.office\.com|logic\.azure\.com|powerautomate\.com|powerplatform\.com)$/i.test(u.hostname);
  } catch { return false; }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface ApprovalInfo { runId: string; agent: string; question: string; changes: string[]; assignedLabel: string | null; recordUrl: string | null }

/** The Slack message for a waiting run. Pure; tested. */
export function slackApprovalBlocks(a: ApprovalInfo) {
  const changes = a.changes.slice(0, 10).map((c) => `• ${esc(c)}`).join('\n');
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `*${esc(a.agent)} needs approval*\n${esc(a.question)}${changes ? `\n${changes}` : ''}` } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `${a.assignedLabel ? `For ${esc(a.assignedLabel)} · ` : ''}Nothing changes until someone decides${a.recordUrl ? ` · <${a.recordUrl}|Open the record>` : ''}` }] },
    { type: 'actions', block_id: 'decision', elements: [
      { type: 'button', action_id: 'approve', style: 'primary', text: { type: 'plain_text', text: 'Approve' }, value: a.runId },
      { type: 'button', action_id: 'reject', style: 'danger', text: { type: 'plain_text', text: 'Reject' }, value: a.runId },
      { type: 'button', action_id: 'open', text: { type: 'plain_text', text: 'Open in CRMagents' }, url: approvalsLink(a.runId) },
    ] },
  ];
}

/** The message after a decision: the same text, with who decided instead of buttons. Pure; tested. */
export function slackDecidedBlocks(a: ApprovalInfo, approve: boolean, by: string, where: string) {
  return [slackApprovalBlocks(a)[0], { type: 'context', elements: [{ type: 'mrkdwn', text: `${approve ? ':white_check_mark: Approved' : ':no_entry_sign: Rejected'} by ${esc(by)} ${where} · <${approvalsLink(a.runId)}|View the run>` }] }];
}

/** The Teams card for a waiting run (Adaptive Card through a Workflows webhook). Pure; tested. */
export function teamsApprovalCard(a: ApprovalInfo) {
  return {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4',
        body: [
          { type: 'TextBlock', text: `${a.agent} needs approval`, weight: 'Bolder', size: 'Medium', wrap: true },
          { type: 'TextBlock', text: a.question, wrap: true },
          ...(a.changes.length ? [{ type: 'TextBlock', text: a.changes.slice(0, 10).map((c) => `- ${c}`).join('\n'), wrap: true }] : []),
          { type: 'TextBlock', text: `${a.assignedLabel ? `For ${a.assignedLabel} · ` : ''}Nothing changes until someone decides`, isSubtle: true, size: 'Small', wrap: true },
        ],
        actions: [
          { type: 'Action.OpenUrl', title: 'Review and approve', url: approvalsLink(a.runId) },
          ...(a.recordUrl ? [{ type: 'Action.OpenUrl', title: 'Open the record', url: a.recordUrl }] : []),
        ],
      },
    }],
  };
}

async function slackApi<T = any>(token: string, method: string, body: Record<string, unknown>): Promise<T & { ok: boolean; error?: string }> {
  const res = await fetch(`https://slack.com/api/${method}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) });
  return (await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }))) as T & { ok: boolean; error?: string };
}

async function channelsOf(accountId: string) {
  const { rows } = await pool.query('select kind, team_id, team_name, channel_id, channel_name, secret_enc, connected_by, created_at from approval_channels where account_id=$1', [accountId]);
  return { slack: rows.find((r) => r.kind === 'slack'), teams: rows.find((r) => r.kind === 'teams') };
}

async function approvalInfo(runId: string): Promise<(ApprovalInfo & { accountId: string; tenantId: string }) | null> {
  const { rows } = await pool.query(
    `select r.id, r.tenant_id, r.steps, r.input, r.assigned_label, coalesce(w.name, 'An agent') as agent, t.account_id, t.sf_instance_url
     from runs r left join workflows w on w.id = r.workflow_id join tenants t on t.id = r.tenant_id where r.id=$1`, [runId]);
  const r = rows[0];
  if (!r) return null;
  const step = ((r.steps ?? []) as { status: string; output?: { message?: string } }[]).find((s) => s.status === 'waiting');
  const [question, ...rest] = String(step?.output?.message ?? 'Approve this change?').split('\n');
  const recordId = typeof r.input?.recordId === 'string' && /^[a-zA-Z0-9]{15,18}$/.test(r.input.recordId) ? r.input.recordId : null;
  return {
    runId: r.id, tenantId: r.tenant_id, accountId: r.account_id, agent: r.agent, question,
    changes: rest.map((c) => c.replace(/^-\s*/, '').trim()).filter(Boolean),
    assignedLabel: r.assigned_label, recordUrl: recordId ? `${r.sf_instance_url}/${recordId}` : null,
  };
}

/** A run is waiting for approval: post it to the workspace's Slack channel and Teams. Never throws. */
export async function postApproval(runId: string): Promise<void> {
  try {
    const a = await approvalInfo(runId);
    if (!a) return;
    const ch = await channelsOf(a.accountId);
    if (ch.slack && slackAvailable()) {
      const r = await slackApi<{ ts?: string; channel?: string }>(decrypt(ch.slack.secret_enc), 'chat.postMessage', { channel: ch.slack.channel_id, text: `${a.agent} needs approval: ${a.question}`, blocks: slackApprovalBlocks(a) });
      if (r.ok && r.ts) await pool.query('insert into approval_messages (run_id, kind, channel, ts) values ($1,$2,$3,$4) on conflict (run_id, kind) do update set channel=excluded.channel, ts=excluded.ts', [runId, 'slack', r.channel ?? ch.slack.channel_id, r.ts]);
    }
    if (ch.teams) {
      const url = decrypt(ch.teams.secret_enc);
      if (teamsWebhookOk(url)) await safeFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(teamsApprovalCard(a)) });
    }
  } catch { /* a convenience: the approval is waiting in the app and in Salesforce either way */ }
}

/** Someone decided (anywhere): the Slack message shows who, instead of buttons. Never throws. */
export async function closeApproval(runId: string, approve: boolean, by: string, where: string): Promise<void> {
  try {
    const { rows } = await pool.query("select channel, ts from approval_messages where run_id=$1 and kind='slack'", [runId]);
    if (!rows[0]) return;
    const a = await approvalInfo(runId);
    const ch = a && (await channelsOf(a.accountId)).slack;
    if (!a || !ch) return;
    await slackApi(decrypt(ch.secret_enc), 'chat.update', { channel: rows[0].channel, ts: rows[0].ts, text: `${a.agent}: ${approve ? 'approved' : 'rejected'} by ${by}`, blocks: slackDecidedBlocks(a, approve, by, where) });
  } catch { /* the decision itself is what matters */ }
}

const installs = new Map<string, { accountId: string; email: string; at: number }>();

export function registerChatApprovals(app: FastifyInstance) {
  app.get('/api/chat-approvals', async (req) => {
    const ch = await channelsOf(req.user!.accountId);
    return {
      slack: { available: slackAvailable(), connected: !!ch.slack, team: ch.slack?.team_name ?? null, channel: ch.slack?.channel_name ?? null, by: ch.slack?.connected_by ?? null },
      teams: { connected: !!ch.teams, by: ch.teams?.connected_by ?? null },
    };
  });

  app.post('/api/chat-approvals/slack/install', async (req, reply) => {
    if (!slackAvailable()) return reply.code(400).send({ error: "Slack isn't set up for CRMagents yet. Ask CRMagents support to turn it on." });
    const state = randomBytes(16).toString('base64url');
    installs.set(state, { accountId: req.user!.accountId, email: req.user!.email, at: Date.now() });
    for (const [k, v] of installs) if (Date.now() - v.at > 15 * 60_000) installs.delete(k);
    const p = new URLSearchParams({ client_id: env('SLACK_CLIENT_ID'), scope: 'chat:write,users:read,users:read.email,incoming-webhook', redirect_uri: slackRedirect(), state });
    return { url: `https://slack.com/oauth/v2/authorize?${p}` };
  });

  app.get('/public/slack/oauth', async (req, reply) => {
    const { code, state, error } = req.query as Record<string, string>;
    const back = (q: string) => reply.redirect(`${config.webUrl}/?tab=settings&section=approvals&${q}`);
    const ctx = state ? installs.get(state) : undefined;
    if (state) installs.delete(state);
    if (!ctx || Date.now() - ctx.at > 15 * 60_000) return back(`error=${encodeURIComponent('That Slack link expired. Try Add to Slack again.')}`);
    if (!code) return back(`error=${encodeURIComponent(error === 'access_denied' ? 'Slack was not added.' : `Slack said: ${error ?? 'cancelled'}`)}`);
    const res = await fetch('https://slack.com/api/oauth.v2.access', { method: 'POST', body: new URLSearchParams({ client_id: env('SLACK_CLIENT_ID'), client_secret: env('SLACK_CLIENT_SECRET'), code, redirect_uri: slackRedirect() }) });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; access_token?: string; team?: { id: string; name: string }; incoming_webhook?: { channel?: string; channel_id?: string } };
    if (!j.ok || !j.access_token || !j.incoming_webhook?.channel_id) return back(`error=${encodeURIComponent(`Slack said: ${j.error ?? 'no channel was chosen'}`)}`);
    await pool.query(
      `insert into approval_channels (account_id, kind, team_id, team_name, channel_id, channel_name, secret_enc, connected_by) values ($1,'slack',$2,$3,$4,$5,$6,$7)
       on conflict (account_id, kind) do update set team_id=excluded.team_id, team_name=excluded.team_name, channel_id=excluded.channel_id, channel_name=excluded.channel_name, secret_enc=excluded.secret_enc, connected_by=excluded.connected_by, created_at=now()`,
      [ctx.accountId, j.team?.id ?? null, j.team?.name ?? null, j.incoming_webhook.channel_id, j.incoming_webhook.channel ?? null, encrypt(j.access_token), ctx.email]);
    await audit(ctx.accountId, ctx.email, `Connected Slack for approvals (${j.incoming_webhook.channel ?? 'a channel'})`, {});
    return back('slack=connected');
  });

  app.delete('/api/chat-approvals/:kind', async (req) => {
    const kind = z.enum(['slack', 'teams']).parse((req.params as { kind: string }).kind);
    const { rows } = await pool.query('delete from approval_channels where account_id=$1 and kind=$2 returning secret_enc', [req.user!.accountId, kind]);
    if (kind === 'slack' && rows[0]) await slackApi(decrypt(rows[0].secret_enc), 'auth.revoke', {}).catch(() => undefined);
    return { ok: true };
  });

  app.put('/api/chat-approvals/teams', async (req) => {
    const { webhookUrl } = z.object({ webhookUrl: z.string().trim().max(2000) }).parse(req.body);
    if (!teamsWebhookOk(webhookUrl)) throw Object.assign(new Error('Paste the webhook address from a Teams workflow ("Post to a channel when a webhook request is received"). It starts with https:// and ends in a Microsoft address.'), { statusCode: 400 });
    await pool.query(
      `insert into approval_channels (account_id, kind, secret_enc, connected_by) values ($1,'teams',$2,$3)
       on conflict (account_id, kind) do update set secret_enc=excluded.secret_enc, connected_by=excluded.connected_by, created_at=now()`,
      [req.user!.accountId, encrypt(webhookUrl), req.user!.email]);
    return { ok: true };
  });

  app.post('/api/chat-approvals/test', async (req) => {
    const { kind } = z.object({ kind: z.enum(['slack', 'teams']) }).parse(req.body);
    const ch = (await channelsOf(req.user!.accountId))[kind];
    if (!ch) throw Object.assign(new Error(`${kind === 'slack' ? 'Slack' : 'Teams'} isn't connected.`), { statusCode: 400 });
    const sample: ApprovalInfo = { runId: '00000000-0000-0000-0000-000000000000', agent: 'Test from CRMagents', question: 'Approval requests will look like this.', changes: ['Case 00001234: Priority Medium → High'], assignedLabel: null, recordUrl: null };
    if (kind === 'slack') {
      const blocks = slackApprovalBlocks(sample).filter((b) => b.type !== 'actions');
      const r = await slackApi(decrypt(ch.secret_enc), 'chat.postMessage', { channel: ch.channel_id, text: 'Test from CRMagents', blocks });
      return r.ok ? { ok: true } : { ok: false, error: `Slack said: ${r.error}` };
    }
    const res = await safeFetch(decrypt(ch.secret_enc), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(teamsApprovalCard(sample)) });
    return res.ok ? { ok: true } : { ok: false, error: `Teams answered ${res.status}` };
  });

  // Button clicks from Slack. Acknowledged at once (Slack waits 3 seconds); the decision runs in the background.
  app.post('/public/slack/interactions', { bodyLimit: 256_000 }, async (req, reply) => {
    const raw = typeof req.body === 'string' ? req.body : '';
    if (!verifySlackSignature(env('SLACK_SIGNING_SECRET'), String(req.headers['x-slack-request-timestamp'] ?? ''), raw, String(req.headers['x-slack-signature'] ?? ''))) return reply.code(401).send();
    let p: SlackPayload;
    try { p = JSON.parse(new URLSearchParams(raw).get('payload') ?? '{}'); } catch { return reply.code(400).send(); }
    const act = p.actions?.[0];
    if (p.type !== 'block_actions' || !act || !['approve', 'reject'].includes(act.action_id)) return reply.code(200).send();
    void decideFromSlack(p, act.action_id === 'approve', String(act.value ?? '')).catch((e) => req.log.warn({ err: String(e) }, 'slack decision failed'));
    return reply.code(200).send();
  });
}

interface SlackPayload { type?: string; team?: { id?: string }; user?: { id?: string }; response_url?: string; actions?: { action_id: string; value?: string }[] }

async function tell(p: SlackPayload, text: string) {
  if (p.response_url?.startsWith('https://hooks.slack.com/')) await fetch(p.response_url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ response_type: 'ephemeral', replace_original: false, text }) }).catch(() => undefined);
}

/** A click: who is it (their Slack email must be someone in the workspace), then the normal approval rules. */
export async function decideFromSlack(p: SlackPayload, approve: boolean, runId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(runId) || !p.team?.id || !p.user?.id) return;
  const { rows: chs } = await pool.query("select account_id, secret_enc from approval_channels where kind='slack' and team_id=$1", [p.team.id]);
  // The run must belong to a workspace that connected this Slack team.
  const { rows: runs } = await pool.query('select r.tenant_id, t.account_id from runs r join tenants t on t.id = r.tenant_id where r.id=$1', [runId]);
  const ch = chs.find((c) => c.account_id === runs[0]?.account_id);
  if (!runs[0] || !ch) return tell(p, "This approval isn't for a CRMagents workspace connected to this Slack.");
  const info = await slackApi<{ user?: { profile?: { email?: string } } }>(decrypt(ch.secret_enc), 'users.info', { user: p.user.id });
  const email = info.user?.profile?.email?.toLowerCase();
  if (!email) return tell(p, "CRMagents couldn't read your Slack email, so it can't tell who you are. Approve in CRMagents instead.");
  const { rows: users } = await pool.query('select email, role from users where account_id=$1 and lower(email)=$2', [ch.account_id, email]);
  const u = users[0];
  if (!u || !roleAtLeast(u.role, 'approver')) return tell(p, `${email} isn't in this CRMagents workspace, so your click didn't count. Ask an admin to invite you.`);
  try {
    // Checked and recorded first (the agent then carries on by itself), so the message only changes for a real decision.
    await decideRun(runs[0].tenant_id, runId, approve, 'Decided in Slack', u.email, u.role, { background: true, where: 'in Slack' });
    await audit(ch.account_id, u.email, `${approve ? 'Approved' : 'Rejected'} a run in Slack`, { tenantId: runs[0].tenant_id }).catch(() => undefined);
  } catch (e) {
    await tell(p, (e as Error).message);
  }
}
