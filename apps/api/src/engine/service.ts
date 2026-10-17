import { afterRunFailed } from '../alerts.js';
import { journalFor } from '../trust/undo.js';
import { checkCap } from './costplan.js';
import { aiContext } from '../trust/aiLog.js';
import { addRecordNote, memoryPrompt } from '../memory/store.js';
import { auditRun } from '../salesforce/audit.js';
import { aiClient } from '../agent/provider.js';
import type { Prefetched } from './prefetch.js';
import { APPROVERS, validateWorkflow, type Workflow } from '@crmagents/shared';
import { createLlm, type Llm } from '../agent/llm.js';
import { pool } from '../db.js';
import { SalesforceClient } from '../salesforce/client.js';
import { checkRunRate, spendGuard } from '../spend.js';
import { accountOf } from '../tenants.js';
import { emptyUsage } from '../agent/pricing.js';
import { dbResultCache } from '../agent/resultCache.js';
import { execute, newState, type RunState } from './executor.js';
import { examplesFor } from './learn.js';
import { makeGuard } from '../smart/policies.js';
import { runTrust } from '../trust/policy.js';
import { notifySalesforce } from '../salesforce/notify.js';

export interface TriggerPayload {
  input?: string;
  recordId?: string;
  objectApiName?: string;
  context?: unknown;
  /** Salesforce user who started it (from the Agent Panel or a Flow): changes are limited to what they could do. */
  sfUserId?: string;
  /** Body of a webhook call. */
  body?: unknown;
  /** The record was deleted (it is read from the Recycle Bin). */
  deleted?: boolean;
  /** The record's data when it came with the trigger (saves the "get record" call). */
  prefetched?: Prefetched;
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
async function makeEnv(tenantId: string, workflowId?: string, st?: RunState) {
  const sf = await SalesforceClient.forTenant(tenantId);
  const accountId = await accountOf(tenantId);
  const runCtx: { runId?: string; dryRun?: boolean; author: string } = { author: 'Agent' };
  if (workflowId) runCtx.author = (await pool.query('select name from workflows where id=$1', [workflowId])).rows[0]?.name ?? 'Agent';
  const memory = async (question: string, recordId?: string) => (await memoryPrompt(accountId, tenantId, '', question, recordId)).text;
  // Masking and limits: the placeholder map and the counters live on the run so they survive pauses.
  const { masker, limits } = await runTrust(accountId, st ? (st.masks ??= {}) : undefined);
  const counters = st ? (st.counters ??= { aiCalls: 0, toolCalls: 0, tokens: 0 }) : undefined;
  let real: Llm | undefined;
  const llm = async (): Promise<Llm> => {
    if (real) return real;
    const client = await aiClient(accountId, { tenantId, purpose: workflowId ? undefined : 'Preview' });
    return (real = createLlm('', sf, spendGuard(accountId), client, await dbResultCache(accountId), { masker, limits, counters,
      // Notes on records, written by AI steps (not in previews: nothing is saved there).
      exec: (name, input) => {
        if (name !== 'remember_about_record') return undefined;
        const i = (input ?? {}) as Record<string, unknown>;
        if (runCtx.dryRun) return Promise.resolve('Noted (preview: not saved).');
        return addRecordNote(tenantId, String(i.record_id ?? ''), String(i.note ?? ''), runCtx.author, runCtx.runId).then(() => 'Noted on the record.');
      } }));
  };
  const lazy: Llm = {
    agent: async (o) => (await llm()).agent(o),
    complete: async (o) => (await llm()).complete(o),
  };
  const rules = await makeGuard(tenantId, sf);
  const allowed = workflowId ? ((await pool.query('select allowed_fields from workflows where id=$1', [workflowId])).rows[0]?.allowed_fields ?? {}) as Record<string, string[]> : {};
  const guard = Object.keys(allowed).length || rules
    ? async (ctx: Parameters<NonNullable<typeof rules>>[0]) => {
      checkAllowedFields(allowed, ctx);
      await rules?.(ctx);
    }
    : undefined;
  const unmask = masker ? <T,>(v: T): T => masker.unmaskValue(v) : undefined;
  // Started by a person in Salesforce: the agent may only change records that person could change themselves.
  const asUser = String(st?.scope?.trigger?.sfUserId ?? '');
  const userGuard = /^005[a-zA-Z0-9]{12,15}$/.test(asUser) ? userAccessGuard(sf, asUser) : undefined;
  const allGuards = userGuard || guard
    ? async (ctx: Parameters<NonNullable<typeof guard>>[0]) => { await userGuard?.(ctx); await guard?.(ctx); }
    : undefined;
  return { sf, llm: lazy, guard: allGuards, unmask, memory, runCtx, ...(workflowId ? { examples: examplesFor(workflowId) } : {}) };
}

/**
 * Checks Salesforce's own record access for a user before an update or delete (sharing rules, ownership, teams).
 * One query per record, remembered for the run.
 */
export function userAccessGuard(sf: SalesforceClient, userId: string) {
  const seen = new Map<string, boolean>();
  return async (ctx: { action: string; recordId?: string; object: string }) => {
    if (!ctx.recordId || !['update', 'delete'].includes(ctx.action) || !/^[a-zA-Z0-9]{15,18}$/.test(ctx.recordId)) return;
    const key = `${ctx.action}:${ctx.recordId}`;
    if (!seen.has(key)) {
      const field = ctx.action === 'delete' ? 'HasDeleteAccess' : 'HasEditAccess';
      const r = await sf.query(`SELECT RecordId, ${field} FROM UserRecordAccess WHERE UserId = '${userId}' AND RecordId = '${ctx.recordId}'`);
      seen.set(key, (r.records[0] as Record<string, unknown> | undefined)?.[field] === true);
    }
    if (!seen.get(key)) {
      throw Object.assign(new Error(`The person who started this agent can't ${ctx.action === 'delete' ? 'delete' : 'edit'} this ${ctx.object} in Salesforce, so the agent won't either.`), { statusCode: 403 });
    }
  };
}

async function persist(runId: string, st: RunState, graph: Workflow, status: string, error?: string, unmask: <T>(v: T) => T = (v) => v) {
  // What people see in the app gets the real values; only the AI saw placeholders.
  const out = unmask(st.final ?? st.last ?? null);
  const text = error ?? (out == null ? '' : typeof out === 'string' ? out : JSON.stringify(out, null, 2));
  const u = st.usage ?? emptyUsage();
  await pool.query(
    `update runs set status=$2, output=$3, steps=$4, state=$5, input_tokens=$6, output_tokens=$7,
       cache_read_tokens=$8, cache_write_tokens=$9, cost_usd=$10 where id=$1 and status <> 'cancelled'`,
    [runId, status, text, JSON.stringify(unmask(st.steps)), status === 'waiting' || status === 'sleeping' ? JSON.stringify({ st, graph }) : null,
      u.input, u.output, u.cacheRead, u.cacheWrite, u.costUsd],
  );
  return { runId, status, output: text, error, steps: st.steps, usage: u };
}

export class Cancelled extends Error {}

async function drive(runId: string, tenantId: string, graph: Workflow, st: RunState, workflowId?: string) {
  // "Still working" signal for the recovery check, plus a saved checkpoint after every finished step.
  const beat = setInterval(() => { void pool.query('update runs set heartbeat_at=now() where id=$1', [runId]).catch(() => {}); }, 30_000);
  try {
    const base = await makeEnv(tenantId, workflowId, st);
    // Everything this run changes in Salesforce is logged, so it can be undone.
    base.sf.journal = journalFor({ tenantId, runId, workflowId });
    base.runCtx.runId = runId;
    const env = {
      ...base,
      run: { tenantId, runId, workflowId },
      checkpoint: async (snap: unknown) => {
        const { rows } = await pool.query(
          "update runs set state=$2, heartbeat_at=now() where id=$1 and status='running' returning id", [runId, JSON.stringify({ st: snap, graph })]);
        if (!rows.length) throw new Cancelled('Run was cancelled');
      },
    };
    const outcome = await aiContext.run({ tenantId, runId }, () => execute(graph, env, st));
    const status = outcome.status === 'done' ? 'done' : outcome.status === 'waiting' ? 'waiting' : outcome.status === 'sleeping' ? 'sleeping' : 'error';
    const saved = await persist(runId, st, graph, status, outcome.error, env.unmask);
    if (status === 'sleeping') await pool.query('update runs set wake_at=$2 where id=$1', [runId, st.sleepUntil]);
    if (status === 'waiting' && st.pending) {
      const node = graph.nodes.find((n) => n.id === st.pending);
      const who = await resolveApprover(tenantId, env.sf, node?.config ?? {}, st.scope.trigger ?? {}).catch(() => ({ email: null, label: 'Anyone in the workspace' }));
      await pool.query('update runs set assigned_to=$2, assigned_label=$3 where id=$1', [runId, who.email, who.label]);
    }
    // Live update for the Salesforce panel, and a bell notification when someone needs to approve.
    void notifySalesforce(tenantId, runId);
    // The changes it made, recorded in Salesforce (CRMagents Agent Activity).
    if (status === 'done' || status === 'error') void auditRun(tenantId, runId);
    if (status === 'error' && workflowId) void afterRunFailed(tenantId, workflowId, outcome.error ?? 'Unknown error').catch(() => undefined);
    return saved;
  } catch (e) {
    if (e instanceof Cancelled) return await persist(runId, st, graph, 'error', e.message);
    if (workflowId) void afterRunFailed(tenantId, workflowId, e instanceof Error ? e.message : String(e)).catch(() => undefined);
    return await persist(runId, st, graph, 'error', e instanceof Error ? e.message : String(e));
  } finally {
    clearInterval(beat);
  }
}

/** Continue a stopped or recovered run from its last checkpoint. */
export async function resumeRun(tenantId: string, runId: string) {
  const { rows } = await pool.query('select status, state, workflow_id from runs where id=$1 and tenant_id=$2', [runId, tenantId]);
  if (!rows[0]) throw Object.assign(new Error('run not found'), { statusCode: 404 });
  if (!['stopped', 'running'].includes(rows[0].status)) throw new Error('Only stopped runs can be resumed');
  const { st, graph } = (rows[0].state ?? {}) as { st?: RunState; graph?: Workflow };
  await pool.query("update runs set status='running', heartbeat_at=now() where id=$1", [runId]);
  if (!st || !graph) {
    // Nothing ran yet: start it again from the beginning with the same input.
    const { rows: r } = await pool.query('select input, w.graph from runs join workflows w on w.id = runs.workflow_id where runs.id=$1', [runId]);
    return drive(runId, tenantId, r[0].graph, newState({ ...(r[0].input ?? {}) }), rows[0].workflow_id ?? undefined);
  }
  return drive(runId, tenantId, graph, st, rows[0].workflow_id ?? undefined);
}

/** Wake runs whose Wait step is over (called every minute). */
export async function wakeRuns() {
  const { rows } = await pool.query(
    "update runs set status='running', heartbeat_at=now(), wake_at=null where status='sleeping' and wake_at <= now() returning id, tenant_id, state, workflow_id");
  for (const r of rows) {
    const { st, graph } = (r.state ?? {}) as { st?: RunState; graph?: Workflow };
    if (!st || !graph) continue;
    st.woke = st.pending; st.pending = undefined;
    void drive(r.id, r.tenant_id, graph, st, r.workflow_id ?? undefined);
  }
  return rows.length;
}

export async function cancelRun(tenantId: string, runId: string, who: string) {
  const { rows } = await pool.query(
    `update runs set status='cancelled', output=$3, state=null where id=$1 and tenant_id=$2 and status in ('running','waiting','stopped','sleeping') returning id`,
    [runId, tenantId, `Cancelled by ${who}. Steps that finished before this were kept.`]);
  if (!rows.length) throw new Error('This run is not running, waiting or stopped.');
  return { ok: true };
}

/** "This agent may only change Status and Priority on Case." Pure; tested. */
export function checkAllowedFields(allowed: Record<string, string[]>, ctx: { action: string; object: string; values?: Record<string, unknown> }) {
  if (ctx.action !== 'update' && ctx.action !== 'create') return;
  const list = allowed[ctx.object];
  if (!list?.length) return;
  const bad = Object.keys(ctx.values ?? {}).filter((f) => !list.some((a) => a.toLowerCase() === f.toLowerCase()));
  if (bad.length) throw new Error(`This agent may only change ${list.join(', ')} on ${ctx.object}; it tried ${bad.join(', ')}.`);
}

/** Who should approve: from the step's "Who approves" setting. Owner/manager come from Salesforce and are matched
 * to people in the workspace by email; if they aren't users here, anyone may approve (and the label says so). */
export async function resolveApprover(tenantId: string, sf: SalesforceClient, cfg: Record<string, unknown>, trigger: Record<string, unknown>): Promise<{ email: string | null; label: string }> {
  const kind = String(cfg.approver ?? APPROVERS[0]);
  const users = (await pool.query('select lower(u.email) email from users u join tenants t on t.account_id = u.account_id where t.id=$1', [tenantId])).rows.map((r) => r.email as string);
  const known = (e?: string | null) => (e && users.includes(e.toLowerCase()) ? e.toLowerCase() : null);
  if (kind === 'A specific person') {
    const e = String(cfg.approverEmail ?? '').trim().toLowerCase();
    return known(e) ? { email: e, label: e } : { email: null, label: `Anyone (${e || 'no email set'} is not in this workspace)` };
  }
  if (kind === 'Record owner' || kind === "Record owner's manager") {
    const obj = String(trigger.objectApiName ?? ''), id = String(trigger.recordId ?? '');
    if (!/^\w+$/.test(obj) || !/^[a-zA-Z0-9]{15,18}$/.test(id)) return { email: null, label: 'Anyone (no record to look up an owner)' };
    const field = kind === 'Record owner' ? 'Owner.Email' : 'Owner.Manager.Email';
    const r = await sf.query(`SELECT ${field} FROM ${obj} WHERE Id = '${id}'`);
    const rec = r.records[0] as any;
    const email = kind === 'Record owner' ? rec?.Owner?.Email : rec?.Owner?.Manager?.Email;
    const who = kind === 'Record owner' ? 'record owner' : "owner's manager";
    return known(email) ? { email: email.toLowerCase(), label: `${email} (${who})` } : { email: null, label: `Anyone (${who}${email ? ` ${email}` : ''} is not in this workspace)` };
  }
  return { email: null, label: 'Anyone in the workspace' };
}

async function createRun(tenantId: string, workflowId: string, trigger: TriggerPayload, startedBy?: string) {
  checkRunRate(await accountOf(tenantId));
  const { rows } = await pool.query('select graph from workflows where id=$1 and tenant_id=$2', [workflowId, tenantId]);
  if (!rows[0]) throw Object.assign(new Error('workflow not found'), { statusCode: 404 });
  const graph = rows[0].graph as Workflow;
  validateWorkflow(graph);
  if (!graph.nodes.some((n) => n.type.startsWith('trigger.'))) throw new Error('Add a trigger node first');
  await checkCap(tenantId, workflowId);
  const { rows: r } = await pool.query(
    'insert into runs (tenant_id, workflow_id, input, status, started_by, heartbeat_at) values ($1,$2,$3,$4,$5,now()) returning id',
    [tenantId, workflowId, JSON.stringify(trigger), 'running', startedBy ?? null],
  );
  return { runId: r[0].id as string, graph };
}

/** Run to completion (or until an approval pause) and return the result. */
export async function startRun(tenantId: string, workflowId: string, trigger: TriggerPayload, startedBy?: string) {
  const { runId, graph } = await createRun(tenantId, workflowId, trigger, startedBy);
  return drive(runId, tenantId, graph, newState({ ...trigger }), workflowId);
}

/** Start in the background; optionally wait up to `waitMs` for it to settle. */
export async function startRunAsync(tenantId: string, workflowId: string, trigger: TriggerPayload, waitMs = 0, startedBy?: string): Promise<RunSnapshot> {
  const { runId, graph } = await createRun(tenantId, workflowId, trigger, startedBy);
  const job = drive(runId, tenantId, graph, newState({ ...trigger }), workflowId).catch(() => undefined);
  if (waitMs > 0) await Promise.race([job, new Promise((r) => setTimeout(r, waitMs))]);
  return getRun(tenantId, runId);
}

/**
 * Bulk starts (a data load in Salesforce runs the Flow for hundreds of records): each run is queued and started
 * as room frees up under the per-minute run limit, instead of being refused.
 */
export async function queueRun(tenantId: string, workflowId: string, trigger: TriggerPayload, startedBy?: string): Promise<{ runId: string; status: string }> {
  await checkCap(tenantId, workflowId);
  const { rows } = await pool.query(
    `insert into runs (tenant_id, workflow_id, input, status, started_by)
     select $1, w.id, $3, 'queued', $4 from workflows w where w.id=$2 and w.tenant_id=$1 returning id`,
    [tenantId, workflowId, JSON.stringify(trigger), startedBy ?? null]);
  if (!rows[0]) throw Object.assign(new Error('workflow not found'), { statusCode: 404 });
  return { runId: rows[0].id, status: 'queued' };
}

/** Starts queued runs, oldest first, while each workspace has room this minute. */
export async function startQueued(): Promise<number> {
  const { rows } = await pool.query(
    `select r.id, r.tenant_id, r.workflow_id, r.input, w.graph, t.account_id
     from runs r join workflows w on w.id = r.workflow_id join tenants t on t.id = r.tenant_id
     where r.status = 'queued' order by r.created_at limit 500`);
  const full = new Set<string>();
  let started = 0;
  for (const r of rows) {
    if (full.has(r.account_id)) continue;
    try { checkRunRate(r.account_id); } catch { full.add(r.account_id); continue; }
    const claimed = await pool.query("update runs set status='running', heartbeat_at=now() where id=$1 and status='queued' returning id", [r.id]);
    if (!claimed.rowCount) continue;
    started++;
    void drive(r.id, r.tenant_id, r.graph as Workflow, newState({ ...(r.input ?? {}) }), r.workflow_id).catch(() => undefined);
  }
  return started;
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

export async function decideRun(tenantId: string, runId: string, approve: boolean, note?: string, who?: string, role?: string) {
  const { rows } = await pool.query('select status, state, workflow_id, started_by, assigned_to from runs where id=$1 and tenant_id=$2', [runId, tenantId]);
  if (!rows[0]) throw Object.assign(new Error('run not found'), { statusCode: 404 });
  if (who) {
    const me = who.toLowerCase();
    const { rows: n } = await pool.query('select count(*)::int c from users u join tenants t on t.account_id = u.account_id where t.id=$1', [tenantId]);
    const team = n[0].c > 1;
    // Separation of duties (only meaningful when there is someone else to ask).
    if (team && rows[0].started_by && rows[0].started_by.toLowerCase() === me) throw Object.assign(new Error('You started this run, so someone else needs to approve it.'), { statusCode: 403 });
    if (team && rows[0].assigned_to && rows[0].assigned_to !== me && role !== 'owner') throw Object.assign(new Error(`This approval is assigned to ${rows[0].assigned_to}.`), { statusCode: 403 });
  }
  if (rows[0].status !== 'waiting' || !rows[0].state) throw new Error('Run is not waiting for approval');
  const { st, graph } = rows[0].state as { st: RunState; graph: Workflow };
  if (!st.pending) throw new Error('No pending approval');
  st.decision = { nodeId: st.pending, approve };
  await pool.query("update runs set status='running', decision_note=$2, decided_at=now(), decided_by=$3, heartbeat_at=now() where id=$1", [runId, note?.trim().slice(0, 500) || null, who ?? null]);
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
  env.runCtx.dryRun = true;
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
