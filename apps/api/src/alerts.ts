import { config } from './config.js';
import { pool } from './db.js';
import { sendMail } from './mailer.js';
import { getSetting } from './settings.js';

// Alerts: things a person must hear about even when nobody is looking at the app.
// - an agent failing run after run (after 3 in a row), and paused automatically after N (default 5) so it stops
//   using Salesforce API calls and AI budget on a problem that needs a person;
// - a Salesforce org that took back Nimbus' access (every agent on it has stopped).
// Each shows in the app (bell) and is emailed to the workspace's owners and admins. The same alert is not
// repeated while an earlier one about the same thing is unread and less than a day old.

export const WARN_AFTER = 3;
export const DEFAULT_PAUSE_AFTER = 5;

/** How many of the latest runs failed in a row. Pure; tested. */
export function failStreak(statuses: string[]): number {
  let n = 0;
  for (const s of statuses) { if (s === 'error') n++; else if (s === 'done') break; }
  return n;
}

/** What to do after a failed run, given the streak and the workspace's pause setting. Pure; tested. */
export function failureAction(streak: number, pauseAfter: number): 'pause' | 'warn' | null {
  if (pauseAfter > 0 && streak >= pauseAfter) return 'pause';
  if (streak === WARN_AFTER || (streak > WARN_AFTER && streak % 10 === 0)) return 'warn';
  return null;
}

async function admins(accountId: string): Promise<string[]> {
  const { rows } = await pool.query("select email from users where account_id=$1 and role in ('owner','admin')", [accountId]);
  return rows.map((r) => r.email);
}

export async function raiseAlert(a: { accountId: string; tenantId?: string; workflowId?: string; kind: string; title: string; body: string }) {
  const { rowCount } = await pool.query(
    `select 1 from alerts where account_id=$1 and kind=$2 and coalesce(workflow_id::text,'')=coalesce($3,'') and coalesce(tenant_id::text,'')=coalesce($4,'')
       and read_at is null and created_at > now() - interval '1 day'`, [a.accountId, a.kind, a.workflowId ?? null, a.tenantId ?? null]);
  if (rowCount) return false;
  const { rows } = await pool.query(
    'insert into alerts (account_id, tenant_id, workflow_id, kind, title, body) values ($1,$2,$3,$4,$5,$6) returning id',
    [a.accountId, a.tenantId ?? null, a.workflowId ?? null, a.kind, a.title.slice(0, 300), a.body.slice(0, 4000)]);
  if ((await getSetting(a.accountId, 'alertEmails')) !== 'off') {
    let sent = false;
    for (const to of await admins(a.accountId)) {
      sent = (await sendMail(a.accountId, { to, subject: `Nimbus: ${a.title}`, text: `${a.body}\n\nOpen Nimbus: ${config.webUrl}` })) || sent;
    }
    if (sent) await pool.query('update alerts set emailed=true where id=$1', [rows[0].id]);
  }
  return true;
}

/** After a run of an agent failed: warn after a few failures in a row, pause it after more. */
export async function afterRunFailed(tenantId: string, workflowId: string, error: string) {
  const { rows: w } = await pool.query(
    'select w.name, w.live, t.account_id from workflows w join tenants t on t.id = w.tenant_id where w.id=$1', [workflowId]);
  if (!w[0]) return;
  const { rows } = await pool.query(
    "select status from runs where workflow_id=$1 and status in ('done','error') order by created_at desc limit 50", [workflowId]);
  const streak = failStreak(rows.map((r) => r.status));
  const setting = await getSetting(w[0].account_id, 'autoPauseAfter');
  const pauseAfter = setting === undefined || setting === '' ? DEFAULT_PAUSE_AFTER : Number(setting);
  const action = failureAction(streak, pauseAfter);
  const name = w[0].name as string;
  const why = error.replace(/\s+/g, ' ').slice(0, 400);
  if (action === 'pause' && w[0].live) {
    const reason = `Paused after ${streak} failed runs in a row. Last error: ${why}`;
    await pool.query('update workflows set live=false, paused_reason=$2 where id=$1', [workflowId, reason.slice(0, 1000)]);
    await raiseAlert({ accountId: w[0].account_id, tenantId, workflowId, kind: 'paused', title: `"${name}" was paused`,
      body: `The agent "${name}" failed ${streak} times in a row, so Nimbus paused it to stop it using Salesforce API calls and AI budget.\n\nLast error: ${why}\n\nFix the cause (often a renamed field, a permission, or a validation rule), then turn it back on from the Agents page.` });
  } else if (action === 'warn') {
    await raiseAlert({ accountId: w[0].account_id, tenantId, workflowId, kind: 'failing', title: `"${name}" is failing`,
      body: `The agent "${name}" failed its last ${streak} runs.${pauseAfter > 0 && w[0].live ? ` It will be paused after ${pauseAfter} failures in a row.` : ''}\n\nLast error: ${why}` });
  }
}

/** A Salesforce org revoked Nimbus' access (refresh token no longer valid). */
export async function orgDisconnected(tenantId: string) {
  const { rows } = await pool.query("select account_id, coalesce(sf_username, sf_instance_url) as name from tenants where id=$1", [tenantId]);
  if (!rows[0]?.account_id) return;
  const { rows: live } = await pool.query('select count(*)::int n from workflows where tenant_id=$1 and live', [tenantId]);
  await raiseAlert({ accountId: rows[0].account_id, tenantId, kind: 'disconnected', title: `Salesforce org "${rows[0].name}" is disconnected`,
    body: `Salesforce no longer accepts Nimbus' access to "${rows[0].name}" (the connection was revoked, the connecting user was deactivated, or its password policy reset it).${live[0].n ? ` ${live[0].n} live agent${live[0].n === 1 ? ' is' : 's are'} stopped until it is reconnected.` : ''}\n\nReconnect it from the Orgs page.` });
}

export async function listAlerts(accountId: string) {
  const { rows } = await pool.query(
    `select a.id, a.kind, a.title, a.body, a.tenant_id as "tenantId", a.workflow_id as "workflowId", a.read_at as "readAt", a.created_at as "createdAt"
     from alerts a where a.account_id=$1 order by a.created_at desc limit 30`, [accountId]);
  return { alerts: rows, unread: rows.filter((r) => !r.readAt).length };
}

export async function markAlertsRead(accountId: string) {
  await pool.query('update alerts set read_at=now() where account_id=$1 and read_at is null', [accountId]);
}
