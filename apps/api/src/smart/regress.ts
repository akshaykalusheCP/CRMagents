import type { Workflow } from '@crmagents/shared';
import { pool } from '../db.js';
import { previewWorkflow } from '../engine/service.js';

// Before saving an edit: replay the edited agent (preview, nothing written) on the inputs of its recent real runs
// and show what would come out differently. AI answers for unchanged prompts come from the cache at no cost.

export interface Regression {
  checked: number;
  same: number;
  /** Past runs whose record no longer exists. */
  gone: number;
  changed: { runId: string; label: string; before: string; after: string }[];
  costUsd: number;
}

type Step = { type: string; status: string; output?: Record<string, unknown> };
/** The outcome worth comparing: AI decisions first (category, extracted values), then what it would change. Pure; tested. */
export function outcomeOf(steps: Step[], final: string): string {
  const parts: string[] = [];
  for (const s of steps) {
    if (s.status !== 'ok' || !s.output) continue;
    if (s.type === 'ai.classify' && s.output.category) parts.push(`category: ${s.output.category}`);
    if (s.type === 'ai.extract' && s.output.data) parts.push(`values: ${JSON.stringify(s.output.data)}`);
  }
  const writes = steps.filter((s) => s.status === 'ok' && /^sf\.(create|update)|^sf\.action$/.test(s.type)).map((s) => s.type.replace('sf.', ''));
  if (writes.length) parts.push(`changes: ${writes.join(', ')}`);
  return parts.join(' · ') || final.replace(/\s+/g, ' ').trim().slice(0, 200);
}

export async function regression(tenantId: string, workflowId: string, graph: Workflow, n = 8): Promise<Regression> {
  const { rows } = await pool.query(
    `select id, input, steps, output from runs
     where tenant_id=$1 and workflow_id=$2 and status = 'done' and not (coalesce(input, '{}'::jsonb) ? 'preview')
     order by created_at desc limit $3`, [tenantId, workflowId, n]);
  if (!rows.length) return { checked: 0, same: 0, gone: 0, changed: [], costUsd: 0 };
  const p = await previewWorkflow(tenantId, workflowId, rows.length, { graph, triggers: rows.map((r) => r.input ?? {}), note: `Checked an edit against ${rows.length} past runs (nothing written)` });
  const changed: Regression['changed'] = [];
  let gone = 0;
  rows.forEach((r, i) => {
    const before = outcomeOf(r.steps ?? [], r.output ?? '');
    const row = p.rows[i];
    if (!row) return;
    if (row.status === 'error' && /NOT_FOUND|ENTITY_IS_DELETED|does not exist/i.test(row.error ?? '')) { gone++; return; }
    // Preview steps aren't returned in full, so rebuild the comparable outcome from what preview reports.
    const after = row.status === 'error' ? `fails: ${row.error}` : [
      ...row.decisions.map((d) => `category: ${d.value}`),
      ...(row.wouldDo.filter((w) => w.action !== 'Ask for approval').length ? [`changes: ${row.wouldDo.filter((w) => w.action !== 'Ask for approval').map((w) => /^Update/.test(w.action) ? 'updateRecord' : /Task/.test(w.action) ? 'createTask' : /^Run /.test(w.action) ? 'action' : 'createRecord').join(', ')}`] : []),
    ].join(' · ') || row.result.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (norm(before) !== norm(after)) changed.push({ runId: r.id, label: row.label, before, after });
  });
  return { checked: p.rows.length - gone, same: p.rows.length - gone - changed.length, gone, changed, costUsd: p.totalCostUsd };
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').replace(/[^\w:,· ]/g, '').trim();
