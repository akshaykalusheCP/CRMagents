import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PLAN_DEFS, type PlanId } from '@crmagents/shared';
import { pool } from './db.js';
import { changePlan, isPlatformAdmin, planSummary } from './plans.js';
import { audit } from './trust/audit.js';
import { billingConfigured } from './billing/stripe.js';
import { mailConfig, viaResend } from './mailer.js';
import { PLATFORM, setSetting } from './settings.js';

// Staff console (CRMagents staff, PLATFORM_ADMINS only; "Not found" for anyone else). Tracks every client: stage
// (trial, paying, past due, churned...), health, the activation funnel, subscriptions and who bought them,
// payments, people, orgs, requests, and staff's own notes, tags and owners. Every staff change is recorded.
// No impersonation and no customer Salesforce data.

const LIST_PRICE: Record<PlanId, number> = { basic: 0, plus: 49, pro: 199, promax: 0 };

export type Stage = 'trial' | 'expired' | 'paying' | 'past_due' | 'churned' | 'comped';
export type Health = 'active' | 'quiet' | 'at_risk';

/** Where a client is in its life with us. Pure; tested. */
export function clientStage(a: { plan: PlanId; trialEndsAt: Date | string | null; subStatus: string | null }, now = Date.now()): Stage {
  if (a.subStatus === 'past_due' || a.subStatus === 'unpaid') return 'past_due';
  if (a.subStatus === 'active' || a.subStatus === 'trialing') return 'paying';
  if (a.plan === 'basic') {
    if (a.subStatus === 'canceled') return 'churned';
    return a.trialEndsAt && new Date(a.trialEndsAt).getTime() > now ? 'trial' : 'expired';
  }
  return a.subStatus === 'canceled' ? 'churned' : 'comped'; // a paid plan set by staff (invoice, partner, Pro Max)
}

/** How alive a client is: active in the last week, quiet for up to two, at risk after that or with a broken org. Pure; tested. */
export function clientHealth(lastActive: Date | string | null, orgIssue: boolean, now = Date.now()): Health {
  if (orgIssue) return 'at_risk';
  if (!lastActive) return 'at_risk';
  const days = (now - new Date(lastActive).getTime()) / 86_400_000;
  return days <= 7 ? 'active' : days <= 14 ? 'quiet' : 'at_risk';
}

const pct = (now: number, before: number) => (before ? (now - before) / before : now ? 1 : 0);

async function accountRows(where = 'true', params: unknown[] = []) {
  const { rows } = await pool.query(
    `select a.id, a.name, a.plan, a.trial_ends_at as "trialEndsAt", a.requested_plan as "requestedPlan", a.plan_set_by as "planSetBy", a.created_at as "createdAt",
            a.tags, a.staff_owner as "staffOwner",
            (select count(*)::int from tenants t where t.account_id = a.id) as orgs,
            exists (select 1 from tenants t where t.account_id = a.id and t.setup_status = 'error') as "orgIssue",
            (select count(*)::int from users u where u.account_id = a.id) as users,
            (select min(email) from users u where u.account_id = a.id and u.role = 'owner') as owner,
            greatest((select max(u.last_login_at) from users u where u.account_id = a.id),
                     (select max(r.created_at) from runs r join tenants t on t.id = r.tenant_id where t.account_id = a.id)) as "lastActive",
            (select count(*)::int from workflows w join tenants t on t.id = w.tenant_id where t.account_id = a.id and w.live) as "liveAgents",
            exists (select 1 from workflows w join tenants t on t.id = w.tenant_id where t.account_id = a.id and w.live_since is not null) as "everLive",
            (select coalesce(sum(r.cost_usd),0)::float from runs r join tenants t on t.id = r.tenant_id where t.account_id = a.id and r.created_at > now() - interval '30 days') as "aiCost30",
            (select count(*)::int from account_notes n where n.account_id = a.id) as notes,
            s.status as "subStatus", s.interval as "subInterval", s.amount_cents as "subAmountCents", s.current_period_end as "renewsAt", s.purchased_by as "purchasedBy", s.cancel_at_period_end as "cancelAtPeriodEnd"
     from accounts a left join subscriptions s on s.account_id = a.id
     where ${where} order by a.created_at desc limit 2000`, params);
  return rows.map((r) => {
    const mrr = r.subStatus === 'active' || r.subStatus === 'trialing' || r.subStatus === 'past_due'
      ? (r.subAmountCents != null ? (r.subInterval === 'year' ? r.subAmountCents / 12 : r.subAmountCents) / 100 : LIST_PRICE[r.plan as PlanId] ?? 0)
      : 0;
    return { ...r, stage: clientStage(r), health: clientHealth(r.lastActive, r.orgIssue), mrr };
  });
}

const staffEvent = (accountId: string | null, by: string, what: string, detail: string | null) =>
  pool.query('insert into staff_events (account_id, by_email, what, detail) values ($1,$2,$3,$4)', [accountId, by, what, detail]);

export function registerPlatform(app: FastifyInstance) {
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/platform/')) return;
    if (!req.user || !isPlatformAdmin(req.user.email)) return reply.code(404).send({ error: 'Not found' });
  });

  app.get('/api/platform/staff', async () => (process.env.PLATFORM_ADMINS ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));

  app.get('/api/platform/overview', async () => {
    const one = async (sql: string) => (await pool.query(sql)).rows[0];
    const accounts = await accountRows();
    const now = Date.now();
    const by = (s: Stage) => accounts.filter((a) => a.stage === s);
    const paying = accounts.filter((a) => a.stage === 'paying' || a.stage === 'past_due');
    const mrr = accounts.reduce((n, a) => n + a.mrr, 0);
    const signups = await one(`select count(*) filter (where created_at > now() - interval '30 days')::int d30,
      count(*) filter (where created_at <= now() - interval '30 days' and created_at > now() - interval '60 days')::int prev30,
      count(*) filter (where created_at > now() - interval '7 days')::int d7, count(*)::int total from accounts`);
    const people = await one(`select count(distinct user_email) filter (where created_at > now() - interval '7 days')::int d7,
      count(distinct user_email) filter (where created_at <= now() - interval '7 days' and created_at > now() - interval '14 days')::int prev7
      from audit_log where action = 'Signed in'`);
    const usersTotal = await one('select count(*)::int n from users');
    const ai = await one(`select coalesce(sum(cost_usd) filter (where created_at > now() - interval '30 days'),0)::float d30,
      coalesce(sum(cost_usd) filter (where created_at <= now() - interval '30 days' and created_at > now() - interval '60 days'),0)::float prev30,
      count(*) filter (where created_at > now() - interval '30 days')::int runs30 from runs`);
    const revenue = await one(`select coalesce(sum(amount_cents) filter (where created_at > now() - interval '30 days'),0)::int d30,
      coalesce(sum(amount_cents) filter (where created_at <= now() - interval '30 days' and created_at > now() - interval '60 days'),0)::int prev30
      from billing_events where type = 'payment_succeeded'`);
    const requests = await one("select count(*) filter (where status='new')::int open from sales_inquiries");
    const brief = (a: (typeof accounts)[number], why: string) => ({ id: a.id, name: a.name, owner: a.owner, why });
    const attention = {
      trialsEnding: by('trial').filter((a) => new Date(a.trialEndsAt).getTime() - now < 3 * 86_400_000).map((a) => brief(a, `trial ends ${new Date(a.trialEndsAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`)),
      paymentFailed: by('past_due').map((a) => brief(a, 'payment failed')),
      upgradeAsks: accounts.filter((a) => a.requestedPlan).map((a) => brief(a, `asked for ${PLAN_DEFS[a.requestedPlan as PlanId]?.name ?? a.requestedPlan}`)),
      churnRisk: paying.filter((a) => a.health === 'at_risk').map((a) => brief(a, a.orgIssue ? 'a Salesforce org is disconnected' : 'no activity for 14+ days')),
      disconnected: accounts.filter((a) => a.orgIssue && !paying.includes(a)).map((a) => brief(a, 'a Salesforce org is disconnected')),
    };
    const series = (await pool.query(`select to_char(d, 'YYYY-MM-DD') as day, (select count(*)::int from accounts a where a.created_at::date = d::date) as signups
      from generate_series(now()::date - 29, now()::date, interval '1 day') d order by d`)).rows;
    return {
      billingConfigured: billingConfigured(),
      kpis: {
        workspaces: { value: signups.total, sub: `+${signups.d7} this week`, change: pct(signups.d30, signups.prev30), changeLabel: 'sign-ups vs last 30 days' },
        mrr: { value: mrr, arr: mrr * 12, paying: paying.length, pastDue: by('past_due').length },
        trials: { value: by('trial').length, ending: attention.trialsEnding.length, expired: by('expired').length },
        people: { value: usersTotal.n, active7: people.d7, change: pct(people.d7, people.prev7) },
        ai: { value: ai.d30, runs: ai.runs30, change: pct(ai.d30, ai.prev30) },
        revenue: { value: revenue.d30 / 100, change: pct(revenue.d30, revenue.prev30) },
        requests: requests.open,
      },
      stages: Object.fromEntries((['trial', 'expired', 'paying', 'past_due', 'churned', 'comped'] as Stage[]).map((s) => [s, by(s).length])),
      plans: Object.fromEntries((['basic', 'plus', 'pro', 'promax'] as PlanId[]).map((p) => [p, accounts.filter((a) => a.plan === p).length])),
      funnel: [
        { step: 'Signed up', n: accounts.length },
        { step: 'Connected Salesforce', n: accounts.filter((a) => a.orgs > 0).length },
        { step: 'Turned an agent on', n: accounts.filter((a) => a.everLive).length },
        { step: 'Paying', n: paying.length },
      ],
      attention,
      series,
    };
  });

  app.get('/api/platform/revenue', async () => {
    const accounts = await accountRows();
    const mrr = accounts.reduce((n, a) => n + a.mrr, 0);
    const byMonth = (await pool.query(`select to_char(m, 'YYYY-MM') as month,
        coalesce((select sum(amount_cents) from billing_events e where e.type='payment_succeeded' and date_trunc('month', e.created_at) = m),0)::int as cents,
        coalesce((select count(*) from billing_events e where e.type='subscription_started' and date_trunc('month', e.created_at) = m),0)::int as started,
        coalesce((select count(*) from billing_events e where e.type='subscription_canceled' and date_trunc('month', e.created_at) = m),0)::int as canceled
      from generate_series(date_trunc('month', now()) - interval '11 months', date_trunc('month', now()), interval '1 month') m order by m`)).rows;
    const subs = accounts.filter((a) => a.subStatus).map((a) => ({ id: a.id, name: a.name, plan: a.plan, status: a.subStatus, interval: a.subInterval, amountCents: a.subAmountCents, mrr: a.mrr, renewsAt: a.renewsAt, purchasedBy: a.purchasedBy, cancelAtPeriodEnd: a.cancelAtPeriodEnd }));
    return { mrr, arr: mrr * 12, paying: accounts.filter((a) => a.stage === 'paying' || a.stage === 'past_due').length, byMonth, subscriptions: subs, billingConfigured: billingConfigured() };
  });

  app.get('/api/platform/accounts', async () => accountRows());

  app.get('/api/platform/accounts.csv', async (_req, reply) => {
    const rows = await accountRows();
    const cols = ['name', 'owner', 'stage', 'plan', 'health', 'mrr', 'subStatus', 'subInterval', 'purchasedBy', 'renewsAt', 'trialEndsAt', 'orgs', 'users', 'liveAgents', 'aiCost30', 'lastActive', 'createdAt', 'staffOwner', 'tags'];
    const cell = (v: unknown) => { const s = v == null ? '' : Array.isArray(v) ? v.join('; ') : v instanceof Date ? v.toISOString() : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="crmagents-clients-${new Date().toISOString().slice(0, 10)}.csv"`);
    return [cols.join(','), ...rows.map((r) => cols.map((c) => cell((r as Record<string, unknown>)[c])).join(','))].join('\n');
  });

  app.get('/api/platform/search', async (req) => {
    const q = z.object({ q: z.string().max(100) }).parse(req.query).q.trim();
    if (q.length < 2) return { workspaces: [], users: [] };
    const like = `%${q.replace(/[%_]/g, '')}%`;
    const workspaces = (await pool.query(`select a.id, a.name, a.plan, (select min(email) from users u where u.account_id=a.id and u.role='owner') as owner from accounts a
      where a.name ilike $1 or exists (select 1 from users u where u.account_id=a.id and u.email ilike $1) order by a.created_at desc limit 8`, [like])).rows;
    const users = (await pool.query(`select u.email, u.role, a.id as "accountId", a.name as "accountName" from users u join accounts a on a.id = u.account_id where u.email ilike $1 order by u.created_at desc limit 8`, [like])).rows;
    return { workspaces, users };
  });

  app.get('/api/platform/accounts/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const [row] = await accountRows('a.id = $1', [id]);
    if (!row) return reply.code(404).send({ error: 'Not found' });
    const q = async (sql: string) => (await pool.query(sql, [id])).rows;
    const members = await q('select email, role, created_at as "createdAt", last_login_at as "lastLoginAt" from users where account_id=$1 order by created_at');
    const orgs = await q('select sf_username as username, sf_instance_url as url, setup_status as status, setup_message as message, use_package as "usePackage", created_at as "connectedAt" from tenants where account_id=$1');
    const payments = await q('select type, plan, amount_cents as "amountCents", currency, invoice_url as "invoiceUrl", detail, created_at as "createdAt" from billing_events where account_id=$1 order by created_at desc limit 100');
    const planHistory = await q('select from_plan as "from", to_plan as "to", changed_by as "by", reason, created_at as "createdAt" from plan_history where account_id=$1 order by created_at desc limit 100');
    const requests = await q('select id, topic, source, status, message, created_at as "createdAt" from sales_inquiries where account_id=$1 order by created_at desc limit 50');
    const notes = await q('select id, author, text, created_at as "createdAt" from account_notes where account_id=$1 order by created_at desc');
    const activity = await q(`select user_email as "user", action, target, created_at as "createdAt" from audit_log where account_id=$1 and action <> 'Signed in' order by created_at desc limit 60`);
    const PAY: Record<string, string> = { payment_succeeded: 'Payment received', payment_failed: 'Payment failed', subscription_started: 'Subscribed', subscription_changed: 'Subscription changed', subscription_canceled: 'Subscription cancelled', refund: 'Refund' };
    // One story of the client: sign-up, people joining, orgs, plan changes, payments, requests, notes, key actions.
    const timeline = [
      ...members.map((m) => ({ at: m.createdAt, kind: 'person', text: `${m.email} joined as ${m.role}` })),
      ...orgs.map((o) => ({ at: o.connectedAt, kind: 'org', text: `Connected Salesforce org ${o.username ?? o.url}` })),
      ...planHistory.map((h) => ({ at: h.createdAt, kind: 'plan', text: h.from === h.to ? (h.reason ?? 'Trial changed') : `${h.from ? `${PLAN_DEFS[h.from as PlanId]?.name ?? h.from} → ` : 'Started on '}${PLAN_DEFS[h.to as PlanId]?.name ?? h.to}`, by: h.by, detail: h.from === h.to ? undefined : h.reason })),
      ...payments.map((p) => ({ at: p.createdAt, kind: 'billing', text: `${PAY[p.type] ?? p.type}${p.amountCents != null ? ` · $${(p.amountCents / 100).toFixed(2)}` : ''}`, detail: p.detail })),
      ...requests.map((r) => ({ at: r.createdAt, kind: 'request', text: `Request (${r.topic}): ${String(r.message ?? '').slice(0, 120)}` })),
      ...notes.map((n) => ({ at: n.createdAt, kind: 'note', text: n.text, by: n.author })),
      ...activity.filter((a) => /agent on|Invited|Asked to upgrade|Exported|Disconnected/.test(a.action)).map((a) => ({ at: a.createdAt, kind: 'activity', text: `${a.action}${a.target ? ` · ${a.target}` : ''}`, by: a.user })),
    ].sort((x, y) => new Date(y.at).getTime() - new Date(x.at).getTime()).slice(0, 150);
    return {
      account: row,
      plan: await planSummary(id),
      members,
      invites: await q('select email, role, invited_by as "invitedBy", expires_at as "expiresAt" from invites where account_id=$1 and accepted_at is null and expires_at > now()'),
      orgs,
      subscription: (await q(`select plan, interval, status, amount_cents as "amountCents", currency, current_period_end as "renewsAt", cancel_at_period_end as "cancelAtPeriodEnd",
        purchased_by as "purchasedBy", started_at as "startedAt", stripe_customer_id as "customerId" from subscriptions where account_id=$1`))[0] ?? null,
      payments, planHistory, requests, notes, activity: activity.slice(0, 30), timeline,
      usage30: (await q(`select count(*)::int runs, coalesce(sum(cost_usd),0)::float cost from runs r join tenants t on t.id = r.tenant_id where t.account_id=$1 and r.created_at > now() - interval '30 days'`))[0],
    };
  });

  app.put('/api/platform/accounts/:id/plan', async (req) => {
    const u = req.user!;
    const b = z.object({ plan: z.enum(['basic', 'plus', 'pro', 'promax']), trialDays: z.number().int().min(0).max(90).optional(), reason: z.string().max(300).optional() }).parse(req.body);
    const id = (req.params as { id: string }).id;
    await changePlan(id, b.plan, u.email, b.reason?.trim() || 'Set by CRMagents staff', { trialDays: b.plan === 'basic' ? b.trialDays ?? 14 : undefined });
    await audit(id, u.email, `Plan set to ${PLAN_DEFS[b.plan].name} by CRMagents`, { target: b.reason });
    return { ok: true };
  });

  app.post('/api/platform/accounts/:id/trial', async (req, reply) => {
    const u = req.user!;
    const b = z.object({ days: z.number().int().min(1).max(60) }).parse(req.body);
    const id = (req.params as { id: string }).id;
    const r = await pool.query(
      `update accounts set trial_ends_at = greatest(coalesce(trial_ends_at, now()), now()) + ($2 || ' days')::interval, trial_ended_at = null
       where id=$1 and plan='basic' returning trial_ends_at`, [id, String(b.days)]);
    if (!r.rowCount) return reply.code(400).send({ error: 'Only Basic workspaces have a trial.' });
    await pool.query("update workflows w set paused_reason=null from tenants t where t.id = w.tenant_id and t.account_id=$1 and w.paused_reason like 'Your free trial ended%'", [id]);
    await pool.query('insert into plan_history (account_id, from_plan, to_plan, changed_by, reason) values ($1,$2,$2,$3,$4)', [id, 'basic', u.email, `Trial extended by ${b.days} days`]);
    await audit(id, u.email, `Trial extended by ${b.days} days by CRMagents`, {});
    return { trialEndsAt: r.rows[0].trial_ends_at };
  });

  // Staff's own organisation of a client: tags and who on our side looks after it.
  app.put('/api/platform/accounts/:id/meta', async (req) => {
    const b = z.object({ tags: z.array(z.string().trim().min(1).max(30)).max(12).optional(), staffOwner: z.string().max(200).nullable().optional() }).parse(req.body);
    const id = (req.params as { id: string }).id;
    const { rows } = await pool.query('select tags, staff_owner from accounts where id=$1', [id]);
    if (!rows[0]) throw Object.assign(new Error('Workspace not found'), { statusCode: 404 });
    if (b.tags) {
      const tags = [...new Set(b.tags.map((t) => t.toLowerCase()))];
      const before: string[] = rows[0].tags ?? [];
      const added = tags.filter((t) => !before.includes(t)), removed = before.filter((t) => !tags.includes(t));
      await pool.query('update accounts set tags=$2 where id=$1', [id, tags]);
      if (added.length || removed.length) await staffEvent(id, req.user!.email, 'Changed tags', [added.length ? `added ${added.join(', ')}` : '', removed.length ? `removed ${removed.join(', ')}` : ''].filter(Boolean).join(' · '));
    }
    if (b.staffOwner !== undefined && (b.staffOwner || null) !== rows[0].staff_owner) {
      await pool.query('update accounts set staff_owner=$2 where id=$1', [id, b.staffOwner || null]);
      await staffEvent(id, req.user!.email, b.staffOwner ? 'Assigned a staff owner' : 'Removed the staff owner', b.staffOwner || rows[0].staff_owner);
    }
    return { ok: true };
  });

  app.post('/api/platform/accounts/:id/notes', async (req) => {
    const b = z.object({ text: z.string().trim().min(1).max(4000) }).parse(req.body);
    const { rows } = await pool.query('insert into account_notes (account_id, author, text) values ($1,$2,$3) returning id', [(req.params as { id: string }).id, req.user!.email, b.text]);
    return { id: rows[0].id };
  });

  app.delete('/api/platform/notes/:id', async (req) => {
    const { rows } = await pool.query('delete from account_notes where id=$1 returning account_id, text', [Number((req.params as { id: string }).id)]);
    if (rows[0]) await staffEvent(rows[0].account_id, req.user!.email, 'Deleted a note', String(rows[0].text).slice(0, 140));
    return { ok: true };
  });

  app.get('/api/platform/users', async () => {
    const { rows } = await pool.query(
      `select u.id, u.email, u.role, u.created_at as "createdAt", u.last_login_at as "lastLoginAt", a.id as "accountId", a.name as "accountName", a.plan
       from users u join accounts a on a.id = u.account_id order by u.created_at desc limit 5000`);
    return rows;
  });

  app.get('/api/platform/payments', async () => {
    const { rows } = await pool.query(
      `select e.id, e.type, e.plan, e.amount_cents as "amountCents", e.currency, e.invoice_url as "invoiceUrl", e.detail, e.created_at as "createdAt", a.id as "accountId", a.name as "accountName"
       from billing_events e left join accounts a on a.id = e.account_id where e.type not like 'ignored:%' order by e.created_at desc limit 500`);
    return rows;
  });

  app.get('/api/platform/requests', async () => {
    const { rows } = await pool.query(
      `select r.id, r.name, r.email, r.company, r.size, r.message, r.topic, r.source, r.status, r.notes, r.handled_by as "handledBy", r.assigned_to as "assignedTo",
              r.created_at as "createdAt", r.updated_at as "updatedAt", r.account_id as "accountId", a.name as "accountName"
       from sales_inquiries r left join accounts a on a.id = r.account_id order by r.created_at desc limit 500`);
    return rows;
  });

  app.put('/api/platform/requests/:id', async (req) => {
    const b = z.object({ status: z.enum(['new', 'contacted', 'won', 'lost', 'closed']).optional(), notes: z.string().max(4000).optional(), assignedTo: z.string().max(200).nullable().optional() }).parse(req.body);
    await pool.query(
      `update sales_inquiries set status=coalesce($2, status), notes=coalesce($3, notes), assigned_to=case when $5 then $4 else assigned_to end, handled_by=$6, updated_at=now() where id=$1`,
      [Number((req.params as { id: string }).id), b.status ?? null, b.notes ?? null, b.assignedTo ?? null, b.assignedTo !== undefined, req.user!.email]);
    return { ok: true };
  });

  // Platform email (invitations, password resets, alerts): a Resend key and a From address, stored encrypted.
  app.get('/api/platform/email', async () => {
    const { key, from } = await mailConfig();
    return { configured: !!key, from, keyHint: key ? `${key.slice(0, 5)}…${key.slice(-4)}` : null };
  });
  app.put('/api/platform/email', async (req) => {
    const b = z.object({ resendKey: z.string().trim().max(200).optional(), mailFrom: z.string().trim().max(200).optional() }).parse(req.body);
    if (b.resendKey !== undefined) {
      if (b.resendKey && !/^re_[\w-]{8,}$/.test(b.resendKey)) throw Object.assign(new Error('That doesn\'t look like a Resend API key (they start with "re_").'), { statusCode: 400 });
      await setSetting(PLATFORM, 'resendKey', b.resendKey);
      await staffEvent(null, req.user!.email, b.resendKey ? 'Set the email key' : 'Removed the email key', null);
    }
    if (b.mailFrom !== undefined) {
      if (b.mailFrom && !/^([^<>]+<)?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>?$/.test(b.mailFrom)) throw Object.assign(new Error('Use an address like "CRMagents <hello@yourdomain.com>".'), { statusCode: 400 });
      await setSetting(PLATFORM, 'mailFrom', b.mailFrom);
      await staffEvent(null, req.user!.email, 'Changed the From address', b.mailFrom || 'default');
    }
    return { ok: true };
  });
  app.post('/api/platform/email/test', async (req) => {
    const b = z.object({ to: z.string().trim().email() }).parse(req.body);
    return viaResend({ to: b.to, subject: 'CRMagents test email', text: `This is a test from the CRMagents staff console, sent by ${req.user!.email}. Invitations, password resets and alerts will arrive like this.` });
  });

  // What staff changed: plans, trials, notes, tags and owners, request handling.
  app.get('/api/platform/staff-log', async () => {
    const { rows } = await pool.query(
      `select * from (
         select h.created_at as "at", h.changed_by as "by", a.id as "accountId", a.name as "accountName",
                case when h.from_plan = h.to_plan then coalesce(h.reason, 'Trial changed') else 'Plan ' || coalesce(h.from_plan, '–') || ' → ' || h.to_plan end as "what", h.reason as "detail"
         from plan_history h join accounts a on a.id = h.account_id where h.changed_by not in ('stripe', 'sign-up', 'trial ended', 'existing workspace')
         union all
         select n.created_at, n.author, a.id, a.name, 'Added a note', left(n.text, 140) from account_notes n join accounts a on a.id = n.account_id
         union all
         select r.updated_at, r.handled_by, r.account_id, coalesce(a.name, r.company), 'Request marked ' || r.status, r.name || ' · ' || r.topic
         from sales_inquiries r left join accounts a on a.id = r.account_id where r.handled_by is not null and r.updated_at is not null
         union all
         select e.created_at, e.by_email, e.account_id, a.name, e.what, e.detail from staff_events e left join accounts a on a.id = e.account_id
       ) x order by "at" desc limit 300`);
    return rows;
  });
}
