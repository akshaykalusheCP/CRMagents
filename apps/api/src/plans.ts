import { FEATURE_LABEL, PLAN_DEFS, planFor, TRIAL_DAYS, type Feature, type PlanId, type PlanLimits } from '@crmagents/shared';
import { pool } from './db.js';

// Plans: what each workspace may use. Checked on the server, so nothing can be unlocked from the browser.
// Safety (approvals, undo, masking, alerts, auto-pause, rules) is never limited by plan.
// A refused request answers 402 with { error, feature | limit, upgrade } so the app can offer the right upgrade.
// Only platform admins (PLATFORM_ADMINS) change a workspace's plan; a workspace can't upgrade itself.

export interface AccountPlan { plan: PlanId; trialEndsAt: Date | null; trialEnded: boolean }

export async function accountPlan(accountId: string): Promise<AccountPlan> {
  const { rows } = await pool.query('select plan, trial_ends_at from accounts where id=$1', [accountId]);
  const plan = (rows[0]?.plan ?? 'basic') as PlanId;
  const trialEndsAt = rows[0]?.trial_ends_at ? new Date(rows[0].trial_ends_at) : null;
  return { plan: PLAN_DEFS[plan] ? plan : 'basic', trialEndsAt, trialEnded: plan === 'basic' && !!trialEndsAt && trialEndsAt.getTime() < Date.now() };
}

const accountOfTenant = async (tenantId: string) => (await pool.query('select account_id from tenants where id=$1', [tenantId])).rows[0]?.account_id as string;

export class PlanError extends Error {
  statusCode = 402;
  constructor(message: string, readonly detail: { feature?: Feature; limit?: keyof PlanLimits; upgrade?: PlanId; trialEnded?: boolean }) { super(message); }
}

/** Does the plan include this feature? Pure; tested. */
export const planHas = (plan: PlanId, f: Feature) => PLAN_DEFS[plan].features.includes(f);

export async function hasFeature(accountId: string, f: Feature) {
  const p = await accountPlan(accountId);
  return !p.trialEnded && planHas(p.plan, f);
}

const PLURAL = new Set<Feature>(['panel', 'emailReplies', 'insights', 'tests', 'costCaps', 'textMessages', 'trustLog']);

export function featureError(f: Feature) {
  const up = planFor(f);
  const many = PLURAL.has(f);
  return new PlanError(`${FEATURE_LABEL[f]} ${many ? 'are' : 'is'} part of the ${PLAN_DEFS[up].name} plan. Upgrade to use ${many ? 'them' : 'it'}.`, { feature: f, upgrade: up });
}

export function trialError() {
  return new PlanError('Your free trial has ended. Choose a plan to keep your agents running; nothing has been deleted.', { trialEnded: true, upgrade: 'plus' });
}

export async function requireFeature(accountId: string, f: Feature) {
  const p = await accountPlan(accountId);
  if (p.trialEnded) throw trialError();
  if (!planHas(p.plan, f)) throw featureError(f);
}
export const requireFeatureForTenant = async (tenantId: string, f: Feature) => requireFeature(await accountOfTenant(tenantId), f);

/** Work can start (agents run, assistants answer): not after a Basic trial has ended. */
export async function requireActive(accountId: string) {
  if ((await accountPlan(accountId)).trialEnded) throw trialError();
}
export const requireActiveForTenant = async (tenantId: string) => requireActive(await accountOfTenant(tenantId));

const NEXT: Record<PlanId, PlanId> = { basic: 'plus', plus: 'pro', pro: 'promax', promax: 'promax' };
const LIMIT_WORDS: Record<keyof PlanLimits, [string, string]> = { orgs: ['Salesforce org', 'Salesforce orgs'], users: ['person', 'people'], liveAgents: ['live agent', 'live agents'], assistants: ['assistant', 'assistants'] };

/** What the workspace uses now, against its limits. */
export async function usage(accountId: string): Promise<PlanLimits> {
  const one = async (sql: string) => (await pool.query(sql, [accountId])).rows[0].n as number;
  const [orgs, users, invites, liveAgents, assistants] = await Promise.all([
    one('select count(*)::int n from tenants where account_id=$1'),
    one('select count(*)::int n from users where account_id=$1'),
    one('select count(*)::int n from invites where account_id=$1 and accepted_at is null and expires_at > now()'),
    one('select count(*)::int n from workflows w join tenants t on t.id = w.tenant_id where t.account_id=$1 and w.live'),
    one('select count(*)::int n from agents a join tenants t on t.id = a.tenant_id where t.account_id=$1'),
  ]);
  return { orgs, users: users + invites, liveAgents, assistants };
}

/** Is there room for one more? Pure; tested. */
export function limitReached(plan: PlanId, kind: keyof PlanLimits, used: number) {
  return used >= PLAN_DEFS[plan].limits[kind];
}

export async function requireRoom(accountId: string, kind: keyof PlanLimits) {
  const p = await accountPlan(accountId);
  if (p.trialEnded) throw trialError();
  const used = (await usage(accountId))[kind];
  if (limitReached(p.plan, kind, used)) {
    const max = PLAN_DEFS[p.plan].limits[kind];
    throw new PlanError(`Your ${PLAN_DEFS[p.plan].name} plan includes ${max} ${LIMIT_WORDS[kind][max === 1 ? 0 : 1]}. Upgrade to ${PLAN_DEFS[NEXT[p.plan]].name} for more.`, { limit: kind, upgrade: NEXT[p.plan] });
  }
}
export const requireRoomForTenant = async (tenantId: string, kind: keyof PlanLimits) => requireRoom(await accountOfTenant(tenantId), kind);

/** Plan, trial and usage for the Plan page (Infinity becomes null: unlimited). */
export async function planSummary(accountId: string) {
  const p = await accountPlan(accountId);
  const { rows } = await pool.query('select requested_plan, plan_updated_at from accounts where id=$1', [accountId]);
  const def = PLAN_DEFS[p.plan];
  const lim = Object.fromEntries(Object.entries(def.limits).map(([k, v]) => [k, Number.isFinite(v) ? v : null]));
  return { plan: p.plan, name: def.name, trialEndsAt: p.trialEndsAt, trialEnded: p.trialEnded, limits: lim, usage: await usage(accountId), features: def.features, requestedPlan: rows[0]?.requested_plan ?? null };
}

export const trialEnd = () => new Date(Date.now() + TRIAL_DAYS * 86_400_000);

/** Hourly: when a Basic trial ends, live agents and website chat pause (nothing is deleted) and admins hear about it. */
export async function endTrials(alert: (accountId: string) => Promise<unknown>) {
  const { rows } = await pool.query("select id from accounts where plan='basic' and trial_ends_at < now() and trial_ended_at is null");
  for (const a of rows) {
    await pool.query(
      `update workflows w set live=false, paused_reason='Your free trial ended. Choose a plan to turn agents back on.'
       from tenants t where t.id = w.tenant_id and t.account_id=$1 and w.live`, [a.id]);
    await pool.query('update agents a set public_enabled=false, sms_enabled=false from tenants t where t.id = a.tenant_id and t.account_id=$1', [a.id]);
    await pool.query('update accounts set trial_ended_at=now() where id=$1', [a.id]);
    await alert(a.id).catch(() => undefined);
  }
  return rows.length;
}

export const isPlatformAdmin = (email: string) => (process.env.PLATFORM_ADMINS ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean).includes(email.toLowerCase());

// Which plan feature a request needs, by route (reads included where the page itself is the feature). Pure; tested.
const ROUTES: [RegExp, Feature, 'any' | 'write'][] = [
  [/^T\/(insights|dashboards)(\/|$)/, 'insights', 'any'],
  [/^\/api\/knowledge(\/sources)?(\/[^/]+(\/sync)?)?$/, 'knowledge', 'write'],
  [/^T\/agents\/[^/]+\/tests(\/|$)/, 'tests', 'write'],
  [/^T\/workflows\/[^/]+\/cap$/, 'costCaps', 'write'],
  [/^T\/workflows\/[^/]+\/deploy$/, 'panel', 'write'],
  [/^T\/(package|salesforce\/pages\/[^/]+)$/, 'panel', 'write'],
  [/^T\/discover\/[^/]+\/(prove|learn)$/, 'prove', 'write'],
  [/^T\/xray(\/|$)/, 'xray', 'any'],
  [/^T\/impact$/, 'impact', 'any'],
  [/^\/api\/trust\/(ai-calls|activity|export)/, 'trustLog', 'any'],
];
export function requiredFeature(method: string, url: string): Feature | null {
  const path = url.split('?')[0].replace(/^\/api\/tenants\/[0-9a-f-]{36}/i, 'T');
  if (method === 'DELETE') return null; // clean-up after a downgrade is always allowed
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  for (const [re, f, when] of ROUTES) if (re.test(path) && (when === 'any' || write)) return f;
  return null;
}
