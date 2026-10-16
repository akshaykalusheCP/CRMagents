import { topoOrder, type Workflow } from '@crmagents/shared';
import { pool } from '../db.js';
import type { RunState } from '../engine/executor.js';
import { resumeRun } from '../engine/service.js';

// Recovering runs that stopped mid-way (server restart, crash). A run that stopped sending its "still working"
// signal is resumed from its last checkpoint when the next step is safe to repeat (reads, AI). If the next step
// changes data, it might already have happened, so the run is marked "stopped" for an admin to resume or cancel.

export const STALE_MS = 5 * 60_000;
export const WRITE_TYPES = new Set(['sf.createRecord', 'sf.updateRecord', 'sf.createTask', 'sf.action', 'notify.slack', 'http.request']);

/** The next step a resumed run would execute, or null if none is left. Pure; tested. */
export function nextStep(graph: Workflow, st: Pick<RunState, 'cursor' | 'active'>): { id: string; type: string; label: string } | null {
  const order = topoOrder(graph);
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  for (let i = st.cursor; i < order.length; i++) {
    const n = nodes.get(order[i])!;
    const active = n.type.startsWith('trigger.') ? false : graph.edges.some((e) => e.target === n.id && st.active.includes(e.id));
    if (active) return { id: n.id, type: n.type, label: n.label ?? n.type };
  }
  return null;
}

/** Is it safe to resume without a person deciding? Pure; tested. */
export function safeToResume(graph: Workflow, st: Pick<RunState, 'cursor' | 'active'>): { safe: boolean; step?: string } {
  const n = nextStep(graph, st);
  if (!n) return { safe: true };
  if (WRITE_TYPES.has(n.type)) return { safe: false, step: n.label };
  if (n.type === 'logic.loop') {
    // A loop may have been part-way through its records; anything inside that writes makes it unsafe.
    if (graph.nodes.some((x) => WRITE_TYPES.has(x.type))) return { safe: false, step: n.label };
  }
  return { safe: true };
}

export async function recoverRuns(log: { error: (o: unknown, m: string) => void }) {
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

/** Clear inputs, AI replies and tool results from runs older than each workspace's retention (default 30 days). */
export async function purgeOldRuns(): Promise<number> {
  const { rows } = await pool.query('select id as tenant_id, account_id from tenants');
  const { getSetting } = await import('../settings.js');
  let n = 0;
  const byAccount = new Map<string, string[]>();
  for (const r of rows) byAccount.set(r.account_id, [...(byAccount.get(r.account_id) ?? []), r.tenant_id]);
  for (const [account, tenants] of byAccount) {
    const v = await getSetting(account, 'retentionDays');
    const days = v && /^\d+$/.test(v) ? Number(v) : 30;
    if (days === 0) continue; // 0 keeps everything
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
