import type { Workflow } from '@crmagents/shared';
import { pool } from '../db.js';
import { SalesforceClient } from '../salesforce/client.js';
import { raiseAlert } from '../alerts.js';

// Price certainty: what an agent will cost a month before it's turned on, and a cap it can't go over.
// Cost per run comes from its real runs when there are enough, else from its steps. Runs per month come from
// how often its trigger happened in the org over the last 30 days (or its schedule). The cap is checked before
// every run: at the cap, runs are refused and a live agent is paused until next month or a higher cap.

const STEP_COST: Record<string, number> = { 'ai.classify': 0.0003, 'ai.extract': 0.004, 'ai.agent': 0.01, 'crm.suggest': 0 };
const LOOP_GUESS = 10; // records per loop when we've never seen it run

/** Typical AI cost of one run from the steps (no history). Pure; tested. */
export function stepsCost(g: Workflow): number {
  const inLoop = new Set<string>();
  for (const l of g.nodes.filter((n) => n.type === 'logic.loop')) {
    // Everything reachable from the loop's body edge counts once per record.
    const stack = g.edges.filter((e) => e.source === l.id && e.sourceHandle !== 'done').map((e) => e.target);
    while (stack.length) { const id = stack.pop()!; if (inLoop.has(id)) continue; inLoop.add(id); g.edges.filter((e) => e.source === id).forEach((e) => stack.push(e.target)); }
  }
  let total = 0;
  for (const n of g.nodes) {
    let c = STEP_COST[n.type] ?? 0;
    if (n.type === 'ai.agent') {
      const tools = Array.isArray(n.config.tools) ? (n.config.tools as string[]) : [];
      if (tools.includes('web_search')) c = 0.05; else if (tools.length) c = 0.03;
    }
    if (n.type === 'ai.classify' && String(n.config.model ?? '').includes('opus')) c = 0.01;
    total += inLoop.has(n.id) ? c * LOOP_GUESS : c;
  }
  return total;
}

/** Runs a month for a schedule. Pure. */
export function scheduledRuns(g: Workflow): number | null {
  const s = g.nodes.find((n) => n.type === 'trigger.schedule');
  if (!s) return null;
  const every = String(s.config.every ?? 'day');
  return every === 'hour' ? 720 : every === 'week' ? 4.3 : 30;
}

export interface Forecast {
  perRunUsd: number; perRunBasis: 'actual' | 'estimate'; runsPerMonth: number; runsBasis: string;
  monthlyUsd: number; capUsd: number | null; spentThisMonthUsd: number; suggestedCapUsd: number;
}

export async function spentThisMonth(workflowId: string): Promise<number> {
  const { rows } = await pool.query("select coalesce(sum(cost_usd),0)::float s from runs where workflow_id=$1 and created_at >= date_trunc('month', now())", [workflowId]);
  return rows[0].s;
}

export async function forecast(tenantId: string, workflowId: string): Promise<Forecast> {
  const { rows } = await pool.query('select graph, monthly_cap_usd::float as cap from workflows where id=$1 and tenant_id=$2', [workflowId, tenantId]);
  if (!rows[0]) throw Object.assign(new Error('Agent not found'), { statusCode: 404 });
  const g = rows[0].graph as Workflow;
  // Real runs (not previews) once there are a few.
  const { rows: hist } = await pool.query(
    `select avg(cost_usd)::float a, count(*)::int n from (select cost_usd from runs where workflow_id=$1 and status in ('done','error','waiting')
       and coalesce(input->>'preview','') = '' order by created_at desc limit 50) x`, [workflowId]);
  const actual = hist[0].n >= 3;
  const perRun = actual ? hist[0].a : stepsCost(g);
  let runs = scheduledRuns(g);
  let basis = runs !== null ? 'its schedule' : '';
  if (runs === null) {
    const { triggersOf } = await import('./watcher.js'); // lazy: the watcher imports the run service, which imports this
    const trigs = triggersOf(g);
    if (trigs.length) {
      const sf = await SalesforceClient.forTenant(tenantId);
      runs = 0;
      for (const t of trigs) {
        const field = t.event === 'created' ? 'CreatedDate' : 'LastModifiedDate';
        const r = await sf.query(`SELECT COUNT() FROM ${t.object} WHERE ${field} = LAST_N_DAYS:30`).catch(() => ({ totalSize: 0 }));
        runs += r.totalSize ?? 0;
      }
      basis = `${trigs.map((t) => `${t.object} records ${t.event}`).join(' + ')} in the last 30 days${trigs.some((t) => t.changed.length) ? ' (fewer when only some fields change)' : ''}`;
    } else {
      const { rows: r } = await pool.query("select count(*)::int n from runs where workflow_id=$1 and created_at > now() - interval '30 days'", [workflowId]);
      runs = r[0].n;
      basis = 'how often it was started in the last 30 days';
    }
  }
  const monthly = perRun * (runs ?? 0);
  return {
    perRunUsd: perRun, perRunBasis: actual ? 'actual' : 'estimate', runsPerMonth: Math.round(runs ?? 0), runsBasis: basis,
    monthlyUsd: monthly, capUsd: rows[0].cap ?? null, spentThisMonthUsd: await spentThisMonth(workflowId),
    suggestedCapUsd: Math.max(1, Math.ceil(monthly * 2)),
  };
}

export async function setCap(tenantId: string, workflowId: string, cap: number | null) {
  const r = await pool.query('update workflows set monthly_cap_usd=$3 where id=$1 and tenant_id=$2', [workflowId, tenantId, cap]);
  if (!r.rowCount) throw Object.assign(new Error('Agent not found'), { statusCode: 404 });
  // A raised cap lifts a cap pause.
  if (cap === null || (await spentThisMonth(workflowId)) < cap) {
    await pool.query("update workflows set paused_reason=null where id=$1 and paused_reason like 'Monthly cap%'", [workflowId]);
  }
}

/** Before a run: refuse it once the agent has spent its cap this month (and pause it if it's live). */
export async function checkCap(tenantId: string, workflowId: string) {
  const { rows } = await pool.query('select w.name, w.live, w.monthly_cap_usd::float cap, t.account_id from workflows w join tenants t on t.id = w.tenant_id where w.id=$1', [workflowId]);
  const w = rows[0];
  if (!w?.cap) return;
  const spent = await spentThisMonth(workflowId);
  if (spent < w.cap) return;
  const reason = `Monthly cap of $${w.cap.toFixed(2)} reached ($${spent.toFixed(2)} spent this month). It starts again next month, or raise the cap.`;
  if (w.live) {
    await pool.query('update workflows set live=false, paused_reason=$2 where id=$1', [workflowId, reason]);
    await raiseAlert({ accountId: w.account_id, tenantId, workflowId, kind: 'cap', title: `"${w.name}" reached its monthly cap`, body: `The agent "${w.name}" has spent its monthly AI cap of $${w.cap.toFixed(2)}, so it was paused. It can start again next month, or raise the cap on the agent's page.` });
  }
  throw Object.assign(new Error(reason), { statusCode: 409 });
}
