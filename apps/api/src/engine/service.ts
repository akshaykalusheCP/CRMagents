import { validateWorkflow, type Workflow } from '@crmagents/shared';
import { anthropicClient, createLlm, type Llm } from '../agent/llm.js';
import { pool } from '../db.js';
import { SalesforceClient } from '../salesforce/client.js';
import { getSetting } from '../settings.js';
import { checkRunRate, spendGuard } from '../spend.js';
import { accountOf } from '../tenants.js';
import { emptyUsage } from '../agent/pricing.js';
import { dbResultCache } from '../agent/resultCache.js';
import { execute, newState, type RunState } from './executor.js';
import { examplesFor } from './learn.js';
import { makeGuard } from '../smart/policies.js';

export interface TriggerPayload {
  input?: string;
  recordId?: string;
  objectApiName?: string;
  context?: unknown;
}

export interface RunSnapshot {
  runId: string;
  status: string;
  output: string;
  error?: string;
  steps: unknown[];
  approval?: string;
}

// The AI key is only needed when a workflow actually uses an AI block, so non-AI workflows run without it.
async function makeEnv(tenantId: string, workflowId?: string) {
  const sf = await SalesforceClient.forTenant(tenantId);
  const accountId = await accountOf(tenantId);
  let real: Llm | undefined;
  const llm = async (): Promise<Llm> => {
    if (real) return real;
    const apiKey = await getSetting(accountId, 'anthropicKey');
    if (!apiKey) throw new Error('Anthropic API key is not configured. Add it in Settings.');
    const workspaceId = await getSetting(accountId, 'anthropicWorkspaceId');
    return (real = createLlm(apiKey, sf, spendGuard(accountId), anthropicClient(apiKey, workspaceId), await dbResultCache(accountId)));
  };
  const lazy: Llm = {
    agent: async (o) => (await llm()).agent(o),
    complete: async (o) => (await llm()).complete(o),
  };
  const guard = await makeGuard(tenantId, sf);
  return { sf, llm: lazy, guard, ...(workflowId ? { examples: examplesFor(workflowId) } : {}) };
}

async function persist(runId: string, st: RunState, graph: Workflow, status: string, error?: string) {
  const out = st.final ?? st.last ?? null;
  const text = error ?? (out == null ? '' : typeof out === 'string' ? out : JSON.stringify(out, null, 2));
  const u = st.usage ?? emptyUsage();
  await pool.query(
    `update runs set status=$2, output=$3, steps=$4, state=$5, input_tokens=$6, output_tokens=$7,
       cache_read_tokens=$8, cache_write_tokens=$9, cost_usd=$10 where id=$1`,
    [runId, status, text, JSON.stringify(st.steps), status === 'waiting' ? JSON.stringify({ st, graph }) : null,
      u.input, u.output, u.cacheRead, u.cacheWrite, u.costUsd],
  );
  return { runId, status, output: text, error, steps: st.steps, usage: u };
}

async function drive(runId: string, tenantId: string, graph: Workflow, st: RunState, workflowId?: string) {
  try {
    const env = await makeEnv(tenantId, workflowId);
    const outcome = await execute(graph, env, st);
    const status = outcome.status === 'done' ? 'done' : outcome.status === 'waiting' ? 'waiting' : 'error';
    return await persist(runId, st, graph, status, outcome.error);
  } catch (e) {
    return await persist(runId, st, graph, 'error', e instanceof Error ? e.message : String(e));
  }
}

async function createRun(tenantId: string, workflowId: string, trigger: TriggerPayload) {
  checkRunRate(await accountOf(tenantId));
  const { rows } = await pool.query('select graph from workflows where id=$1 and tenant_id=$2', [workflowId, tenantId]);
  if (!rows[0]) throw Object.assign(new Error('workflow not found'), { statusCode: 404 });
  const graph = rows[0].graph as Workflow;
  validateWorkflow(graph);
  if (!graph.nodes.some((n) => n.type.startsWith('trigger.'))) throw new Error('Add a trigger node first');
  const { rows: r } = await pool.query(
    'insert into runs (tenant_id, workflow_id, input, status) values ($1,$2,$3,$4) returning id',
    [tenantId, workflowId, JSON.stringify(trigger), 'running'],
  );
  return { runId: r[0].id as string, graph };
}

/** Run to completion (or until an approval pause) and return the result. */
export async function startRun(tenantId: string, workflowId: string, trigger: TriggerPayload) {
  const { runId, graph } = await createRun(tenantId, workflowId, trigger);
  return drive(runId, tenantId, graph, newState({ ...trigger }), workflowId);
}

/** Start in the background; optionally wait up to `waitMs` for it to settle. */
export async function startRunAsync(tenantId: string, workflowId: string, trigger: TriggerPayload, waitMs = 0): Promise<RunSnapshot> {
  const { runId, graph } = await createRun(tenantId, workflowId, trigger);
  const job = drive(runId, tenantId, graph, newState({ ...trigger }), workflowId).catch(() => undefined);
  if (waitMs > 0) await Promise.race([job, new Promise((r) => setTimeout(r, waitMs))]);
  return getRun(tenantId, runId);
}

export async function getRun(tenantId: string, runId: string): Promise<RunSnapshot> {
  const { rows } = await pool.query('select id, status, output, steps, state from runs where id=$1 and tenant_id=$2', [runId, tenantId]);
  if (!rows[0]) throw Object.assign(new Error('run not found'), { statusCode: 404 });
  const r = rows[0];
  const steps = (r.steps ?? []) as { label: string; status: string; ms: number; error?: string; output?: any }[];
  const waiting = steps.find((s) => s.status === 'waiting');
  return {
    runId: r.id,
    status: r.status,
    output: r.output ?? '',
    error: r.status === 'error' ? r.output ?? undefined : undefined,
    steps: steps.map((s) => ({ label: s.label, status: s.status, ms: s.ms, error: s.error })),
    approval: waiting?.output?.message,
  };
}

export async function decideRun(tenantId: string, runId: string, approve: boolean, note?: string) {
  const { rows } = await pool.query('select status, state, workflow_id from runs where id=$1 and tenant_id=$2', [runId, tenantId]);
  if (!rows[0]) throw Object.assign(new Error('run not found'), { statusCode: 404 });
  if (rows[0].status !== 'waiting' || !rows[0].state) throw new Error('Run is not waiting for approval');
  const { st, graph } = rows[0].state as { st: RunState; graph: Workflow };
  if (!st.pending) throw new Error('No pending approval');
  st.decision = { nodeId: st.pending, approve };
  await pool.query("update runs set status='running', decision_note=$2, decided_at=now() where id=$1", [runId, note?.trim().slice(0, 500) || null]);
  return drive(runId, tenantId, graph, st, rows[0].workflow_id ?? undefined);
}

export interface PreviewRow {
  recordId: string;
  label: string;
  status: 'done' | 'error';
  result: string;
  /** What the workflow would change or send (nothing is actually written in preview). */
  wouldDo: { action: string; detail: unknown }[];
  /** Short AI decisions worth showing, e.g. a classification. */
  decisions: { step: string; nodeId: string; value: string; input: string; categories: string[]; examplesUsed: number }[];
  costUsd: number;
  error?: string;
}

const LABEL_FIELDS = ['CaseNumber', 'Subject', 'Name', 'Title'];

/**
 * Runs a record-triggered workflow on the org's most recent records in preview mode: AI and reads run for real,
 * writes/messages/approvals are only described. Lets an admin judge the results before going live.
 */
export async function previewWorkflow(tenantId: string, workflowId: string, limit = 10, opts: { ids?: string[]; graph?: Workflow; triggers?: Record<string, unknown>[]; note?: string } = {}) {
  const { rows } = await pool.query('select graph from workflows where id=$1 and tenant_id=$2', [workflowId, tenantId]);
  if (!rows[0]) throw Object.assign(new Error('workflow not found'), { statusCode: 404 });
  const graph = opts.graph ?? (rows[0].graph as Workflow);
  validateWorkflow(graph);
  const trigger = graph.nodes.find((n) => n.type === 'trigger.salesforce');
  const object = String(trigger?.config.objectApiName ?? '').trim();
  if (!object && !opts.triggers) throw new Error('Preview needs a Salesforce record trigger with an object (for example Case).');
  checkRunRate(await accountOf(tenantId));

  const env = await makeEnv(tenantId, workflowId);
  const { fields } = await import('../salesforce/schema.js');
  const known = new Set(object ? (await fields(tenantId, env.sf, object)).map((f) => f.name) : []);
  const labelFields = LABEL_FIELDS.filter((f) => known.has(f)).slice(0, 2);
  const cols = `Id${labelFields.map((f) => `, ${f}`).join('')}`;
  const safeIds = (opts.ids ?? []).filter((id) => /^[a-zA-Z0-9]{15,18}$/.test(id));
  // Given triggers (regression replays) run as-is; otherwise the chosen records, or the most recent ones.
  const recent = opts.triggers
    ? { records: opts.triggers.map((t, i) => ({ Id: String(t.recordId ?? `run-${i}`), __trigger: t })) }
    : safeIds.length
      ? await env.sf.query(`SELECT ${cols} FROM ${object} WHERE Id IN (${safeIds.map((i) => `'${i}'`).join(',')})`)
      : await env.sf.query(`SELECT ${cols} FROM ${object} ORDER BY LastModifiedDate DESC LIMIT ${Math.min(Math.max(limit, 1), 20)}`);

  const preview = { ...env, dryRun: true };
  const out: PreviewRow[] = [];
  let total = emptyUsage();
  const queue = [...(recent.records as Record<string, string>[])];
  await Promise.all([0, 1, 2].map(async () => {
    while (queue.length) {
      const rec = queue.shift()!;
      const st = newState((rec as any).__trigger ?? { recordId: rec.Id, objectApiName: object });
      const outcome = await execute(graph, preview, st).catch((e) => ({ status: 'error' as const, error: String(e instanceof Error ? e.message : e) }));
      const u = st.usage ?? emptyUsage();
      total = { input: total.input + u.input, cacheWrite: total.cacheWrite + u.cacheWrite, cacheRead: total.cacheRead + u.cacheRead, output: total.output + u.output, costUsd: total.costUsd + u.costUsd };
      const res = st.final ?? st.last ?? '';
      out.push({
        recordId: rec.Id,
        label: labelFields.map((f) => rec[f]).filter(Boolean).join(' · ') || rec.Id,
        status: outcome.status === 'error' ? 'error' : 'done',
        error: outcome.status === 'error' ? outcome.error : undefined,
        result: typeof res === 'string' ? res : JSON.stringify(res),
        wouldDo: st.steps.filter((s) => (s.output as any)?.wouldDo).map((s) => ({ action: (s.output as any).wouldDo, detail: (s.output as any).fields ?? (s.output as any).text ?? (s.output as any).message })),
        decisions: st.steps.filter((s) => s.type === 'ai.classify' && s.status === 'ok').map((s) => {
          const o = s.output as any;
          return { step: s.label, nodeId: s.nodeId, value: String(o?.category ?? ''), input: String(o?.input ?? ''), categories: o?.categories ?? [], examplesUsed: o?.examplesUsed ?? 0 };
        }),
        costUsd: u.costUsd,
      });
    }
  }));

  // Count the preview's AI spend toward the daily budget and show it in Runs.
  await pool.query(
    `insert into runs (tenant_id, workflow_id, input, status, output, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
     values ($1,$2,$3,'done',$4,$5,$6,$7,$8,$9)`,
    [tenantId, workflowId, JSON.stringify({ preview: out.length }), opts.note ?? `Preview on ${out.length} records (nothing written)`, total.input, total.output, total.cacheRead, total.cacheWrite, total.costUsd],
  );
  const order = new Map((recent.records as Record<string, string>[]).map((r, i) => [r.Id, i]));
  out.sort((a, b) => order.get(a.recordId)! - order.get(b.recordId)!);
  return { object, rows: out, totalCostUsd: total.costUsd, avgCostUsd: out.length ? total.costUsd / out.length : 0 };
}
