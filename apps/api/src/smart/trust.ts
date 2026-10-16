import type { WFEdge, Workflow } from '@crmagents/shared';
import { pool } from '../db.js';

// Agents earn autonomy. From the last 30 days of real runs and approval decisions, each agent gets a health line
// and, when the evidence is strong, one suggestion: drop the approval step, review it, or fix it.

export const AUTONOMY_MIN = 15; // approvals in a row, none rejected, before we suggest dropping approval
export const REVIEW_RATE = 0.3; // rejection share that flags an agent for review
export const FAIL_RATE = 0.2;

export interface Decision { approved: boolean; note?: string | null; at: string }
export interface AgentHealth {
  workflowId: string;
  runs: number; succeeded: number; failed: number; waiting: number;
  approved: number; rejected: number; streak: number;
  lastError?: string;
  rejectNotes: string[];
  suggestion?: { kind: 'drop_approval' | 'review' | 'fix'; title: string; detail: string };
}

type RunRow = { status: string; steps: { type: string; status: string; output?: { approved?: boolean } }[]; output: string | null; decision_note: string | null; created_at: string };

/** Health and suggestion for one agent from its runs (newest first). Pure; tested. */
export function assess(workflowId: string, runs: RunRow[], hasApproval: boolean): AgentHealth {
  const decisions: Decision[] = [];
  for (const r of runs) {
    const a = r.steps?.find((s) => s.type === 'logic.approval' && s.status === 'ok' && typeof s.output?.approved === 'boolean');
    if (a) decisions.push({ approved: !!a.output!.approved, note: r.decision_note, at: r.created_at });
  }
  let streak = 0;
  for (const d of decisions) { if (!d.approved) break; streak++; }
  const h: AgentHealth = {
    workflowId,
    runs: runs.length,
    succeeded: runs.filter((r) => r.status === 'done').length,
    failed: runs.filter((r) => r.status === 'error').length,
    waiting: runs.filter((r) => r.status === 'waiting').length,
    approved: decisions.filter((d) => d.approved).length,
    rejected: decisions.filter((d) => !d.approved).length,
    streak,
    lastError: runs.find((r) => r.status === 'error')?.output ?? undefined,
    rejectNotes: decisions.filter((d) => !d.approved && d.note).map((d) => d.note!).slice(0, 5),
  };
  const decided = h.approved + h.rejected;
  if (h.failed >= 3 && h.failed / Math.max(h.runs, 1) >= FAIL_RATE) {
    h.suggestion = { kind: 'fix', title: 'Keeps failing', detail: `${h.failed} of ${h.runs} runs failed in 30 days. Latest: ${String(h.lastError ?? '').slice(0, 160)}` };
  } else if (decided >= 5 && h.rejected / decided >= REVIEW_RATE) {
    h.suggestion = { kind: 'review', title: 'People often reject it', detail: `${h.rejected} of ${decided} changes were rejected.${h.rejectNotes.length ? ` Reasons: ${h.rejectNotes.join('; ')}` : ''}` };
  } else if (hasApproval && streak >= AUTONOMY_MIN && h.rejected === 0) {
    h.suggestion = { kind: 'drop_approval', title: 'Ready to run on its own', detail: `${streak} changes approved in a row and none rejected. You could let it act without asking.` };
  }
  return h;
}

export async function agentHealth(tenantId: string): Promise<AgentHealth[]> {
  const [{ rows: flows }, { rows: runs }] = await Promise.all([
    pool.query('select id, graph from workflows where tenant_id=$1', [tenantId]),
    pool.query(
      `select workflow_id, status, steps, output, decision_note, created_at from runs
       where tenant_id=$1 and workflow_id is not null and created_at > now() - interval '30 days'
         and not (coalesce(input, '{}'::jsonb) ? 'preview')
       order by created_at desc`, [tenantId]),
  ]);
  return flows.map((f) => assess(f.id, runs.filter((r) => r.workflow_id === f.id), (f.graph as Workflow).nodes.some((n) => n.type === 'logic.approval')));
}

/** The workflow without its approval steps: what came before connects straight to what ran after "approved";
 * the "not approved" exits are dropped. Pure; tested. */
export function removeApproval(g: Workflow): Workflow {
  let nodes = [...g.nodes];
  let edges = [...g.edges];
  for (const a of g.nodes.filter((n) => n.type === 'logic.approval')) {
    const incoming = edges.filter((e) => e.target === a.id);
    const approved = edges.filter((e) => e.source === a.id && e.sourceHandle === 'approved');
    const rejectedTargets = edges.filter((e) => e.source === a.id && e.sourceHandle === 'rejected').map((e) => e.target);
    const added: WFEdge[] = [];
    for (const i of incoming) for (const o of approved) {
      added.push({ id: `${i.source}:${i.sourceHandle ?? 'out'}->${o.target}`, source: i.source, target: o.target, sourceHandle: i.sourceHandle });
    }
    // Drop "not approved" outputs that nothing else leads to.
    const orphan = new Set(rejectedTargets.filter((t) => !edges.some((e) => e.target === t && e.source !== a.id)));
    nodes = nodes.filter((n) => n.id !== a.id && !orphan.has(n.id));
    edges = [...edges.filter((e) => e.source !== a.id && e.target !== a.id && !orphan.has(e.source) && !orphan.has(e.target)), ...added];
  }
  return { ...g, nodes, edges };
}
