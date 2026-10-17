import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PLAN_DEFS, type PlanId } from '@crmagents/shared';
import { pool } from './db.js';
import { changePlan, isPlatformAdmin, planSummary } from './plans.js';
import { audit } from './trust/audit.js';
import { billingConfigured } from './billing/stripe.js';

// Super admin: CRMagents staff (PLATFORM_ADMINS) see every workspace: who signed up, which plan and subscription,
// who bought it, payments, members, orgs, usage and requests, and can change a plan or extend a trial.
// Everything here answers "Not found" to anyone else, and every staff change is recorded.
// No impersonation and no customer Salesforce data: workspace contents stay private to the workspace.

const MONTHLY: Record<PlanId, number> = { basic: 0, plus: 49, pro: 199, promax: 0 };

export function registerPlatform(app: FastifyInstance) {
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/platform/')) return;
    if (!req.user || !isPlatformAdmin(req.user.email)) return reply.code(404).send({ error: 'Not found' });
  });

  app.get('/api/platform/overview', async () => {
    const one = async (sql: string) => (await pool.query(sql)).rows[0];
    const plans = (await pool.query('select plan, count(*)::int n from accounts group by plan')).rows;
    const subs = (await pool.query("select plan, interval, amount_cents, status from subscriptions where stripe_subscription_id is not null and status in ('active','trialing','past_due')")).rows;
    // Monthly recurring revenue from live subscriptions (yearly ones count a twelfth); list price where Stripe gave no amount.
    const mrr = subs.reduce((n, s) => n + (s.amount_cents != null ? (s.interval === 'year' ? s.amount_cents / 12 : s.amount_cents) / 100 : MONTHLY[s.plan as PlanId] ?? 0), 0);
    const trials = await one(`select count(*) filter (where plan='basic' and trial_ends_at > now())::int active,
      count(*) filter (where plan='basic' and trial_ends_at > now() and trial_ends_at < now() + interval '3 days')::int ending,
      count(*) filter (where plan='basic' and trial_ends_at <= now())::int ended from accounts`);
    const signups = await one("select count(*) filter (where created_at > now() - interval '30 days')::int d30, count(*) filter (where created_at > now() - interval '7 days')::int d7, count(*)::int total from accounts");
    const users = await one("select count(*)::int total, count(*) filter (where last_login_at > now() - interval '7 days')::int active7 from users");
    const ai = await one("select coalesce(sum(cost_usd),0)::float cost30, count(*)::int runs30 from runs where created_at > now() - interval '30 days'");
    const requests = await one("select count(*) filter (where status='new')::int open from sales_inquiries");
    const failed = await one("select count(*)::int n from subscriptions where status in ('past_due','unpaid')");
    const series = (await pool.query(`select to_char(d, 'YYYY-MM-DD') as day, (select count(*)::int from accounts a where a.created_at::date = d::date) as signups
      from generate_series(now()::date - 29, now()::date, interval '1 day') d order by d`)).rows;
    return { plans: Object.fromEntries(plans.map((p) => [p.plan, p.n])), subscriptions: subs.length, mrr, trials, signups, users, ai, openRequests: requests.open, paymentIssues: failed.n, billingConfigured: billingConfigured(), series };
  });

  app.get('/api/platform/accounts', async () => {
    const { rows } = await pool.query(
      `select a.id, a.name, a.plan, a.trial_ends_at as "trialEndsAt", a.requested_plan as "requestedPlan", a.plan_set_by as "planSetBy", a.created_at as "createdAt",
              (select count(*)::int from tenants t where t.account_id = a.id) as orgs,
              (select count(*)::int from users u where u.account_id = a.id) as users,
              (select min(email) from users u where u.account_id = a.id and u.role = 'owner') as owner,
              (select max(u.last_login_at) from users u where u.account_id = a.id) as "lastActive",
              (select count(*)::int from workflows w join tenants t on t.id = w.tenant_id where t.account_id = a.id and w.live) as "liveAgents",
              (select coalesce(sum(r.cost_usd),0)::float from runs r join tenants t on t.id = r.tenant_id where t.account_id = a.id and r.created_at > now() - interval '30 days') as "aiCost30",
              s.status as "subStatus", s.interval as "subInterval", s.amount_cents as "subAmountCents", s.current_period_end as "renewsAt", s.purchased_by as "purchasedBy", s.cancel_at_period_end as "cancelAtPeriodEnd"
       from accounts a left join subscriptions s on s.account_id = a.id
       order by a.created_at desc limit 1000`);
    return rows;
  });

  app.get('/api/platform/accounts/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const { rows: a } = await pool.query('select id, name, plan, trial_ends_at as "trialEndsAt", requested_plan as "requestedPlan", plan_set_by as "planSetBy", created_at as "createdAt" from accounts where id=$1', [id]);
    if (!a[0]) return reply.code(404).send({ error: 'Not found' });
    const q = async (sql: string) => (await pool.query(sql, [id])).rows;
    return {
      account: a[0],
      plan: await planSummary(id),
      members: await q('select email, role, created_at as "createdAt", last_login_at as "lastLoginAt" from users where account_id=$1 order by created_at'),
      invites: await q('select email, role, invited_by as "invitedBy", expires_at as "expiresAt" from invites where account_id=$1 and accepted_at is null and expires_at > now()'),
      orgs: await q('select sf_username as username, sf_instance_url as url, setup_status as status, use_package as "usePackage", created_at as "connectedAt" from tenants where account_id=$1'),
      subscription: (await q(`select plan, interval, status, amount_cents as "amountCents", currency, current_period_end as "renewsAt", cancel_at_period_end as "cancelAtPeriodEnd",
        purchased_by as "purchasedBy", started_at as "startedAt", stripe_customer_id as "customerId" from subscriptions where account_id=$1`))[0] ?? null,
      payments: await q('select type, plan, amount_cents as "amountCents", currency, invoice_url as "invoiceUrl", detail, created_at as "createdAt" from billing_events where account_id=$1 order by created_at desc limit 50'),
      planHistory: await q('select from_plan as "from", to_plan as "to", changed_by as "by", reason, created_at as "createdAt" from plan_history where account_id=$1 order by created_at desc limit 50'),
      requests: await q('select id, topic, source, status, message, created_at as "createdAt" from sales_inquiries where account_id=$1 order by created_at desc limit 20'),
      activity: await q('select user_email as "user", action, target, created_at as "createdAt" from audit_log where account_id=$1 order by created_at desc limit 30'),
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
      `select r.id, r.name, r.email, r.company, r.size, r.message, r.topic, r.source, r.status, r.notes, r.handled_by as "handledBy", r.created_at as "createdAt",
              r.account_id as "accountId", a.name as "accountName"
       from sales_inquiries r left join accounts a on a.id = r.account_id order by r.created_at desc limit 500`);
    return rows;
  });

  app.put('/api/platform/requests/:id', async (req) => {
    const b = z.object({ status: z.enum(['new', 'contacted', 'won', 'lost', 'closed']), notes: z.string().max(4000).optional() }).parse(req.body);
    await pool.query('update sales_inquiries set status=$2, notes=coalesce($3, notes), handled_by=$4, updated_at=now() where id=$1', [Number((req.params as { id: string }).id), b.status, b.notes ?? null, req.user!.email]);
    return { ok: true };
  });
}
