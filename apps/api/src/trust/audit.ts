import type { FastifyInstance } from 'fastify';
import type { Workflow } from '@crmagents/shared';
import { pool } from '../db.js';
import { cancelSubscriptionNow } from '../billing/stripe.js';
import { getSetting } from '../settings.js';
import { decrypt } from '../crypto.js';

// The activity log (who did what in the workspace) and the Trust Center's facts. Every successful change made
// through the app is recorded by one hook, in plain words; sign-ins and failed sign-ins are recorded by auth.

export async function audit(accountId: string, userEmail: string | null, action: string, o: { target?: string; tenantId?: string | null; ip?: string } = {}) {
  await pool.query('insert into audit_log (account_id, user_email, action, target, tenant_id, ip) values ($1,$2,$3,$4,$5,$6)',
    [accountId, userEmail, action.slice(0, 200), o.target?.slice(0, 300) ?? null, o.tenantId ?? null, o.ip ?? null]).catch(() => undefined);
}

// Route → what it means. Anything not listed is logged as "<method> <route>" so nothing is missed.
const LABELS: [string, string][] = [
  ['PUT /api/settings', 'Changed workspace settings'],
  ['POST /api/oauth/start', 'Started connecting a Salesforce org'],
  ['DELETE /api/tenants/:tenantId', 'Disconnected a Salesforce org'],
  ['POST /api/tenants/:tenantId/workflows', 'Created an agent'],
  ['PUT /api/tenants/:tenantId/workflows/:id', 'Edited an agent'],
  ['DELETE /api/tenants/:tenantId/workflows/:id', 'Deleted an agent'],
  ['POST /api/tenants/:tenantId/workflows/:id/live', 'Turned an agent on or off'],
  ['PUT /api/tenants/:tenantId/workflows/:id/cap', 'Changed an agent\'s monthly cap'],
  ['POST /api/tenants/:tenantId/workflows/:id/autonomy', 'Changed when an agent asks first'],
  ['PUT /api/tenants/:tenantId/workflows/:id/allowed-fields', 'Changed which fields an agent may change'],
  ['POST /api/tenants/:tenantId/workflows/:id/deploy', 'Deployed an agent as a Salesforce Flow'],
  ['POST /api/tenants/:tenantId/workflows/:id/run', 'Ran an agent'],
  ['POST /api/tenants/:tenantId/runs/:runId/decision', 'Approved or rejected a change'],
  ['POST /api/tenants/:tenantId/runs/:runId/cancel', 'Cancelled a run'],
  ['POST /api/tenants/:tenantId/undo', 'Undid agent changes'],
  ['POST /api/tenants/:tenantId/agents', 'Created an assistant'],
  ['PUT /api/tenants/:tenantId/agents/:agentId', 'Edited an assistant'],
  ['DELETE /api/tenants/:tenantId/agents/:agentId', 'Deleted an assistant'],
  ['PUT /api/tenants/:tenantId/agents/:agentId/public', 'Changed website chat or text messages'],
  ['POST /api/tenants/:tenantId/rules', 'Added a rule for agents'],
  ['DELETE /api/tenants/:tenantId/rules/:id', 'Removed a rule for agents'],
  ['POST /api/knowledge', 'Uploaded a guide'],
  ['DELETE /api/knowledge/:id', 'Deleted a guide'],
  ['POST /api/team/invites', 'Invited someone'],
  ['PUT /api/team/users/:id', 'Changed someone\'s role'],
  ['DELETE /api/team/users/:id', 'Removed someone from the workspace'],
  ['POST /api/team/users/:id/reset-link', 'Made a password reset link'],
  ['POST /api/auth/password', 'Changed their password'],
  ['POST /api/tenants/:tenantId/discover/:id/prove', 'Built and replayed an agent from Discover'],
  ['POST /api/tenants/:tenantId/xray/replace', 'Drafted an agent from the automation X-ray'],
];
const LABEL = new Map(LABELS);
const QUIET = /\/(builder\/chat|insights\/(ask|summary|tiles)|dashboards\/(run|drill|draft)|knowledge\/search|alerts\/read|workflows\/draft|preview|backtest|regression|feedback)$/;

export function registerAudit(app: FastifyInstance) {
  app.addHook('onResponse', async (req, reply) => {
    const u = req.user;
    if (!u || req.method === 'GET' || reply.statusCode >= 400) return;
    const route = req.routeOptions?.url ?? req.url.split('?')[0];
    if (!route.startsWith('/api/') || QUIET.test(route)) return;
    const params = (req.params ?? {}) as Record<string, string>;
    let action = LABEL.get(`${req.method} ${route}`) ?? `${req.method} ${route.replace(/^\/api\//, '')}`;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (route.endsWith('/live')) action = body.on ? 'Turned an agent on' : 'Turned an agent off';
    if (route.endsWith('/decision')) action = body.approve ? 'Approved a change' : 'Rejected a change';
    let target = params.id ?? params.agentId ?? params.runId ?? '';
    if (params.id && route.includes('/workflows/')) {
      const { rows } = await pool.query('select name from workflows where id=$1', [params.id]).catch(() => ({ rows: [] as { name: string }[] }));
      if (rows[0]) target = rows[0].name;
    }
    if (route === '/api/team/invites' && typeof body.email === 'string') target = `${body.email} as ${body.role}`;
    if (route === '/api/settings') target = Object.keys(body).filter((k) => body[k] !== undefined).join(', ');
    await audit(u.accountId, u.email, action, { target, tenantId: params.tenantId, ip: req.ip });
  });
}

export async function listAudit(accountId: string, limit = 200) {
  const { rows } = await pool.query(
    'select id, user_email as "user", action, target, tenant_id as "tenantId", ip, created_at as "createdAt" from audit_log where account_id=$1 order by created_at desc limit $2',
    [accountId, Math.min(limit, 1000)]);
  return rows;
}

/** The facts behind the Trust Center, for this workspace, as they are right now. */
export async function trustFacts(accountId: string) {
  const s = (k: Parameters<typeof getSetting>[1]) => getSetting(accountId, k);
  const [provider, mask, maskFields, retention, maxAi, maxTools, maxTokens, alerts, budget, memory] = await Promise.all([
    s('aiProvider'), s('maskPii'), s('maskFields'), s('retentionDays'), s('maxAiCalls'), s('maxToolCalls'), s('maxTokens'), s('alertEmails'), s('dailyBudgetUsd'), s('memoryEnabled')]);
  const { rows: mem } = await pool.query("select count(*) filter (where scope='team')::int team, count(*) filter (where scope='personal')::int personal from memories where account_id=$1", [accountId]);
  const { rows: notes } = await pool.query('select count(*)::int n from record_notes n join tenants t on t.id = n.tenant_id where t.account_id=$1', [accountId]);
  const { rows: orgs } = await pool.query('select id, sf_username as username, sf_instance_url as url, setup_status as status, created_at as "connectedAt" from tenants where account_id=$1', [accountId]);
  const { rows: wf } = await pool.query('select w.graph, w.live, w.monthly_cap_usd from workflows w join tenants t on t.id = w.tenant_id where t.account_id=$1', [accountId]);
  const live = wf.filter((w) => w.live);
  const writes = (g: Workflow) => g.nodes.filter((n) => ['sf.createRecord', 'sf.updateRecord', 'sf.deleteRecord', 'sf.upsertRecord', 'sf.createTask', 'sf.action', 'sf.emailReply', 'notify.sms'].includes(n.type));
  const asks = (g: Workflow) => g.nodes.some((n) => n.type === 'logic.approval') || writes(g).every((n) => n.config.askFirst === 'Yes');
  const liveWriting = live.filter((w) => writes(w.graph).length);
  const { rows: calls } = await pool.query("select count(*)::int n, coalesce(sum(masked_values),0)::int masked, count(distinct model)::int models from ai_calls where account_id=$1 and created_at > now() - interval '30 days'", [accountId]);
  const { rows: team } = await pool.query('select role, count(*)::int n from users where account_id=$1 group by role', [accountId]);
  const { rows: rules } = await pool.query('select count(*)::int n from policies r join tenants t on t.id = r.tenant_id where t.account_id=$1', [accountId]).catch(() => ({ rows: [{ n: 0 }] }));
  const { rows: undo } = await pool.query("select count(*)::int n, count(*) filter (where undone_at is not null)::int undone from run_changes c join tenants t on t.id = c.tenant_id where t.account_id=$1 and c.created_at > now() - interval '30 days'", [accountId]);
  return {
    ai: { provider: provider || 'anthropic', calls30d: calls[0].n, maskedValues30d: calls[0].masked },
    masking: { on: mask !== 'off', extraFields: (maskFields ?? '').split(',').map((x) => x.trim()).filter(Boolean) },
    retentionDays: retention && /^\d+$/.test(retention) ? Number(retention) : 30,
    limits: { aiCalls: Number(maxAi) || 40, toolCalls: Number(maxTools) || 60, tokens: Number(maxTokens) || 400000, dailyBudgetUsd: budget || '2' },
    agents: { total: wf.length, live: live.length, liveWriting: liveWriting.length, liveWritingAsking: liveWriting.filter((w) => asks(w.graph)).length, capped: wf.filter((w) => w.monthly_cap_usd != null).length },
    rules: rules[0].n,
    changes30d: undo[0].n, undone30d: undo[0].undone,
    team: Object.fromEntries(team.map((r) => [r.role, r.n])),
    alerts: alerts !== 'off',
    memory: { on: memory !== 'off', team: mem[0].team, personal: mem[0].personal, recordNotes: notes[0].n },
    salesforce: { scopes: ['api', 'refresh_token'], orgs },
  };
}

/** Everything the workspace has here, as one JSON file (no secrets, no Salesforce data beyond what runs kept). */
export async function exportWorkspace(accountId: string) {
  const q = async (sql: string) => (await pool.query(sql, [accountId])).rows;
  return {
    exportedAt: new Date().toISOString(),
    account: (await q('select id, name, created_at from accounts where id=$1'))[0],
    users: await q('select email, role, created_at, last_login_at from users where account_id=$1'),
    orgs: await q('select id, sf_org_id, sf_username, sf_instance_url, created_at from tenants where account_id=$1'),
    agents: await q('select w.id, w.tenant_id, w.name, w.graph, w.live, w.monthly_cap_usd, w.created_at, w.updated_at from workflows w join tenants t on t.id = w.tenant_id where t.account_id=$1'),
    assistants: await q('select a.id, a.tenant_id, a.name, a.system_prompt, a.tools, a.created_at from agents a join tenants t on t.id = a.tenant_id where t.account_id=$1'),
    runs: await q('select r.id, r.tenant_id, r.workflow_id, r.agent_id, r.status, r.input, r.output, r.steps, r.cost_usd, r.started_by, r.created_at from runs r join tenants t on t.id = r.tenant_id where t.account_id=$1 order by r.created_at desc limit 20000'),
    changes: await q('select c.* from run_changes c join tenants t on t.id = c.tenant_id where t.account_id=$1 order by c.created_at desc limit 50000'),
    guides: await q('select id, title, file_name, kind, created_at from knowledge_docs where account_id=$1'),
    aiCalls: await q('select id, created_at, provider, model, purpose, request, response, masked_values, cost_usd from ai_calls where account_id=$1 order by created_at desc limit 5000'),
    activity: await q('select created_at, user_email, action, target, ip from audit_log where account_id=$1 order by created_at desc limit 20000'),
    rules: await q('select r.* from policies r join tenants t on t.id = r.tenant_id where t.account_id=$1'),
    memories: await q('select id, scope, owner, text, source, created_by, uses, last_used_at, created_at from memories where account_id=$1'),
    recordNotes: await q('select n.tenant_id, n.record_id, n.note, n.author, n.created_at from record_notes n join tenants t on t.id = n.tenant_id where t.account_id=$1'),
    chats: await q(`select c.id, c.tenant_id, c.agent_id, c.channel, c.record_id, c.title, c.created_at,
                      coalesce((select json_agg(json_build_object('role', m.role, 'text', m.text, 'at', m.created_at) order by m.created_at) from conversation_messages m where m.conversation_id = c.id), '[]') as messages
                    from conversations c where c.account_id=$1 order by c.created_at desc limit 5000`),
    invites: await q('select email, role, invited_by, expires_at, accepted_at, created_at from invites where account_id=$1'),
    plan: {
      history: await q('select from_plan, to_plan, changed_by, reason, created_at from plan_history where account_id=$1 order by created_at'),
      subscription: (await q('select plan, interval, status, amount_cents, currency, current_period_end, cancel_at_period_end, purchased_by, started_at from subscriptions where account_id=$1'))[0] ?? null,
      payments: await q("select type, plan, amount_cents, currency, invoice_url, created_at from billing_events where account_id=$1 and type not like 'ignored:%' order by created_at"),
    },
  };
}

/** Delete the workspace: a paid subscription is cancelled (so charging stops), Salesforce access is revoked, then
 *  everything here is removed. If the subscription can't be cancelled, nothing is deleted. */
export async function deleteWorkspace(accountId: string) {
  const { rows: subs } = await pool.query("select stripe_subscription_id from subscriptions where account_id=$1 and stripe_subscription_id is not null and status not in ('canceled', 'incomplete_expired')", [accountId]);
  for (const s of subs) {
    if (!process.env.STRIPE_SECRET_KEY) throw Object.assign(new Error('This workspace has a paid subscription and online payment is not reachable right now, so it was not deleted. Contact us to close it.'), { statusCode: 409 });
    await cancelSubscriptionNow(s.stripe_subscription_id);
  }
  const { rows } = await pool.query('select sf_instance_url, refresh_token_enc from tenants where account_id=$1', [accountId]);
  for (const t of rows) {
    try {
      await fetch(`${t.sf_instance_url}/services/oauth2/revoke`, { method: 'POST', body: new URLSearchParams({ token: decrypt(t.refresh_token_enc) }) });
    } catch { /* gone already */ }
  }
  await pool.query('delete from accounts where id=$1', [accountId]); // everything else is removed with it
  return { revoked: rows.length };
}
