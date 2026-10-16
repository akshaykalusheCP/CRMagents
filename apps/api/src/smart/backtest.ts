import { assertBudget } from '../salesforce/limits.js';
import type { Workflow } from '@crmagents/shared';
import { pool } from '../db.js';
import { previewWorkflow, type PreviewRow } from '../engine/service.js';
import { SalesforceClient } from '../salesforce/client.js';
import { triggerOf, watchQuery } from '../engine/watcher.js';

// "What would this agent have done last month?" Count the records that would have triggered it in the last 30
// days, run it in preview on a sample spread across that period (nothing is written), and scale up.

export interface Backtest {
  kind: 'record' | 'schedule';
  object: string;
  days: number;
  /** Times it would have run in the period. */
  total: number;
  sampled: number;
  /** Of the sample: runs that would change something, runs skipped by its conditions, runs that would fail. */
  acted: number; skipped: number; failed: number;
  /** Changes it would have made over the whole period, by kind ("Create Task": 380). */
  actions: { action: string; count: number }[];
  costPerRunUsd: number;
  estCostUsd: number;
  examples: PreviewRow[];
  errors: string[];
}

/** Evenly spread picks from a list (keeps the sample from being all from one day). Pure; tested. */
export function spread<T>(items: T[], k: number): T[] {
  if (items.length <= k) return items;
  return Array.from({ length: k }, (_, i) => items[Math.floor((i * items.length) / k)]);
}

/** Scale sample outcomes to the whole period. Pure; tested. */
export function extrapolate(rows: Pick<PreviewRow, 'status' | 'wouldDo' | 'costUsd'>[], total: number, perRunMultiplier = 1) {
  const n = rows.length || 1;
  const scale = total / n;
  const acted = rows.filter((r) => r.status === 'done' && r.wouldDo.some((w) => w.action !== 'Ask for approval')).length;
  const failed = rows.filter((r) => r.status === 'error').length;
  const counts = new Map<string, number>();
  for (const r of rows) for (const w of r.wouldDo) if (w.action !== 'Ask for approval') {
    const key = String(w.action).replace(/\s+[a-zA-Z0-9]{15,18}$/, ''); // "Update Case 500.." -> "Update Case"
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const cost = rows.reduce((a, r) => a + r.costUsd, 0) / n;
  return {
    acted, failed, skipped: rows.length - acted - failed,
    actions: [...counts].map(([action, c]) => ({ action, count: Math.round(c * scale * perRunMultiplier) })).sort((a, b) => b.count - a.count),
    costPerRunUsd: cost,
    estCostUsd: cost * total,
  };
}

const SLOTS: Record<string, number> = { hour: 24 * 30, day: 30, week: 4 };

export async function backtest(tenantId: string, workflowId: string, sample = 10): Promise<Backtest> {
  const { rows } = await pool.query('select graph from workflows where id=$1 and tenant_id=$2', [workflowId, tenantId]);
  if (!rows[0]) throw Object.assign(new Error('workflow not found'), { statusCode: 404 });
  const graph = rows[0].graph as Workflow;
  const days = 30;

  const sched = graph.nodes.find((n) => n.type === 'trigger.schedule');
  if (sched) {
    // One real dry run of the job; it would run once per slot.
    const total = SLOTS[String(sched.config.every ?? 'day')] ?? 30;
    const p = await previewWorkflow(tenantId, workflowId, 1, { triggers: [{ input: 'Replay of a scheduled run' }], note: 'Replay of last 30 days (nothing written)' });
    const x = extrapolate(p.rows, total);
    return { kind: 'schedule', object: '', days, total, sampled: p.rows.length, ...x, examples: p.rows, errors: p.rows.map((r) => r.error!).filter(Boolean) };
  }

  const trig = triggerOf(graph);
  if (!trig) throw new Error('Replay needs a record trigger or a schedule.');
  assertBudget(tenantId, 'background');
  const sf = await SalesforceClient.forTenant(tenantId);
  const since = new Date(Date.now() - days * 86_400_000);
  const { field } = watchQuery(trig.object, trig.event, since);
  const at = since.toISOString().replace(/\.\d+Z$/, 'Z');
  // Every matching Id across the period, so the sample is spread over all of it (not just the first days).
  // Large periods are read with a Bulk API 2.0 job: a few calls whatever the number of records.
  const [count, ids] = await Promise.all([
    sf.query(`SELECT COUNT() FROM ${trig.object} WHERE ${field} >= ${at}`),
    sf.queryAll(`SELECT Id FROM ${trig.object} WHERE ${field} >= ${at} ORDER BY ${field} ASC`, 50_000),
  ]);
  const picked = spread((ids.records as { Id: string }[]).map((r) => r.Id), sample);
  if (!picked.length) return { kind: 'record', object: trig.object, days, total: 0, sampled: 0, acted: 0, skipped: 0, failed: 0, actions: [], costPerRunUsd: 0, estCostUsd: 0, examples: [], errors: [] };
  const p = await previewWorkflow(tenantId, workflowId, picked.length, { ids: picked, note: `Replay of last ${days} days on ${picked.length} sample records (nothing written)` });
  const x = extrapolate(p.rows, count.totalSize);
  return { kind: 'record', object: trig.object, days, total: count.totalSize, sampled: p.rows.length, ...x, examples: p.rows.slice(0, 5), errors: [...new Set(p.rows.map((r) => r.error!).filter(Boolean))] };
}
