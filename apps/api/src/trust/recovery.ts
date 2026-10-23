import { topoOrder, WRITE_NODE_TYPES, type Workflow } from '@crmagents/shared';
import { TOOLS } from '../agent/tools.js';
import { pool } from '../db.js';
import type { RunState } from '../engine/executor.js';
import { resumeRun } from '../engine/service.js';

// Recovering runs that stopped mid-way (server restart, crash). A run that stopped sending its "still working"
// signal is resumed from its last checkpoint when the next step is safe to repeat (reads, AI). If the next step
// changes data, it might already have happened, so the run is marked "stopped" for an admin to resume or cancel.

export const STALE_MS = 5 * 60_000;
// Every step that changes something outside the run (a record, an email to a customer, a Slack message), plus a
// saved suggestion (people are told about it). Kept in step with the node list so new write steps are covered.
export const WRITE_TYPES = new Set([...WRITE_NODE_TYPES, 'crm.suggest']);

/** A step that may have changed something: a write step, or an AI agent step allowed to use a write tool. */
function writes(n: { type: string; config?: Record<string, unknown> }) {
  if (WRITE_TYPES.has(n.type)) return true;
  const tools = n.type === 'ai.agent' && Array.isArray(n.config?.tools) ? (n.config!.tools as string[]) : [];
  return tools.some((t) => TOOLS[t]?.write);
}

/** The next step a resumed run would execute, or null if none is left. Pure; tested. */
export function nextStep(graph: Workflow, st: Pick<RunState, 'cursor' | 'active'>): { id: string; type: string; label: string; config?: Record<string, unknown> } | null {
  const order = topoOrder(graph);
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  for (let i = st.cursor; i < order.length; i++) {
    const n = nodes.get(order[i])!;
    const active = n.type.startsWith('trigger.') ? false : graph.edges.some((e) => e.target === n.id && st.active.includes(e.id));
    if (active) return { id: n.id, type: n.type, label: n.label ?? n.type, config: n.config };
  }
  return null;
}

/** Is it safe to resume without a person deciding? Pure; tested. */
export function safeToResume(graph: Workflow, st: Pick<RunState, 'cursor' | 'active'>): { safe: boolean; step?: string } {
  const n = nextStep(graph, st);
  if (!n) return { safe: true };
  if (writes(n)) return { safe: false, step: n.label };
  if (n.type === 'logic.loop') {
    // A loop may have been part-way through its records; anything inside that writes makes it unsafe.
    if (graph.nodes.some(writes)) return { safe: false, step: n.label };
  }
  return { safe: true };
}

export async function recoverRuns(log: { error: (o: unknown, m: string) => void }) {
  // Assistant answers live in the server's memory: after a restart there is nothing to resume, so say so.
  await pool.query(
    `update runs set status='error', output='Interrupted: the server restarted while answering. Ask again.'
     where status='running' and workflow_id is null and coalesce(heartbeat_at, created_at) < now() - ($1 || ' milliseconds')::interval`,
    [String(STALE_MS)]).catch((e) => log.error({ err: String(e) }, 'assistant recovery failed'));
  const { rows } = await pool.query(
    `select id, tenant_id, state from runs where status='running' and workflow_id is not null
       and coalesce(heartbeat_at, created_at) < now() - ($1 || ' milliseconds')::interval limit 20`, [String(STALE_MS)]);
  for (const r of rows) {
    const { st, graph } = (r.state ?? {}) as { st?: RunState; graph?: Workflow };
    const check = st && graph ? safeToResume(graph, st) : { safe: true };
    if (!check.safe) {
      await pool.query("update runs set status='stopped', output=$2 where id=$1 and status='running'",
        [r.id, `Stopped before "${check.step}" because the server restarted. It may or may not have run; resume to continue (it could repeat that step) or cancel.`]);
      continue;
    }
    await resumeRun(r.tenant_id, r.id).catch((e) => log.error({ run: r.id, err: String(e) }, 'resume failed'));
  }
}

export const AI_LOG_DETAIL_DAYS = 7;
const TRIMMED_REQUEST = { trimmed: true, system: '', messages: [{ role: 'user', content: '(Details cleared after 7 days to keep the log small. Model, tokens and cost are kept.)' }], tools: [] };
const TRIMMED_RESPONSE = { content: '(cleared)' };

/** Clear inputs, AI replies and tool results from runs older than each workspace's retention (default 30 days). */
export async function purgeOldRuns(): Promise<number> {
  // Text conversations are only remembered for a day; keep a month for support, then let them go.
  await pool.query("delete from channel_messages where created_at < now() - interval '30 days'").catch(() => undefined);
  const { rows } = await pool.query('select id as tenant_id, account_id from tenants');
  const { getSetting } = await import('../settings.js');
  let n = 0;
  const byAccount = new Map<string, string[]>();
  for (const r of rows) byAccount.set(r.account_id, [...(byAccount.get(r.account_id) ?? []), r.tenant_id]);
  for (const [account, tenants] of byAccount) {
    const v = await getSetting(account, 'retentionDays');
    const days = v && /^\d+$/.test(v) ? Number(v) : 30;
    if (days === 0) continue; // 0 keeps everything
    // What was sent to the AI, and saved chats, go after the same period as the run details.
    await pool.query("delete from conversation_messages m using conversations c where c.id = m.conversation_id and c.account_id=$1 and m.created_at < now() - ($2 || ' days')::interval", [account, String(days)]).catch(() => undefined);
    await pool.query('delete from conversations c where c.account_id=$1 and not exists (select 1 from conversation_messages m where m.conversation_id = c.id) and c.updated_at < now() - interval \'1 day\'', [account]).catch(() => undefined);
    await pool.query("delete from ai_calls where account_id=$1 and created_at < now() - ($2 || ' days')::interval", [account, String(days)]).catch(() => undefined);
    // The full text sent to and returned by the AI is the bulk of the log: kept for a week, then cleared. Model,
    // tokens, cost and masking counts stay for the whole retention period.
    if (days > AI_LOG_DETAIL_DAYS) {
      await pool.query(
        `update ai_calls set request = $3::jsonb, response = case when response is null then null else $4::jsonb end
         where account_id=$1 and created_at < now() - ($2 || ' days')::interval and not (request ? 'trimmed')`,
        [account, String(AI_LOG_DETAIL_DAYS), JSON.stringify(TRIMMED_REQUEST), JSON.stringify(TRIMMED_RESPONSE)]).catch(() => undefined);
    }
    const res = await pool.query(
      `update runs set input = null, state = null, trace = '[]',
         output = case when output is null then null else '(Details cleared after ' || $2 || ' days)' end,
         steps = coalesce((select jsonb_agg(s - 'output' - 'trace') from jsonb_array_elements(steps) s), '[]'),
         purged_at = now()
       where tenant_id = any($1) and purged_at is null and status not in ('running','waiting','stopped')
         and created_at < now() - ($2 || ' days')::interval`, [tenants, String(days)]);
    n += res.rowCount ?? 0;
  }
  return n;
}
