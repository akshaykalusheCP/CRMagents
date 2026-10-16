import { topoOrder, WRITE_NODE_TYPES, type WFNode, type Workflow } from '@crmagents/shared';
import { ApprovalRequired } from '../smart/policies.js';
import { addUsage, emptyUsage, totalTokens, type Usage } from '../agent/pricing.js';
import { EXECUTORS, type Env, type NodeResult, type WriteBuffer } from './nodes.js';
import { resolveRaw } from './template.js';

export interface Step {
  nodeId: string;
  type: string;
  label: string;
  status: 'ok' | 'error' | 'waiting';
  output?: unknown;
  error?: string;
  ms: number;
  iteration?: number;
  trace?: unknown;
  reused?: boolean;
  /** AI use by this step: tokens and cost (for the run's full history). */
  ai?: { tokens: number; costUsd: number };
}

export interface RunState {
  scope: Record<string, any>;
  active: string[]; // ids of edges that carried a signal
  steps: Step[];
  cursor: number;
  tokens: number; // total of all usage meters, kept for quick display
  usage?: Usage;
  last?: unknown;
  final?: unknown;
  pending?: string; // approval node waiting for a decision
  decision?: { nodeId: string; approve: boolean };
  /** Personal-data placeholders for this run ([EMAIL_1] -> real value), kept across pauses. */
  masks?: Record<string, string>;
  /** Wait step: the run sleeps until this time, then resumes at that step. */
  sleepUntil?: string;
  woke?: string;
  /** AI/tool/token use so far, so per-run limits hold across pauses. */
  counters?: { aiCalls: number; toolCalls: number; tokens: number };
}

export interface Outcome {
  status: 'done' | 'waiting' | 'sleeping' | 'error';
  error?: string;
}

const MAX_STEPS = 500;

export function newState(trigger: Record<string, unknown>): RunState {
  return { scope: { trigger }, active: [], steps: [], cursor: 0, tokens: 0, usage: emptyUsage() };
}

function reach(wf: Workflow, starts: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...starts];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of wf.edges) if (e.source === id) stack.push(e.target);
  }
  return seen;
}

/** Nodes run inside a loop: reachable from "each" but not from "done". */
function loopBody(wf: Workflow, loopId: string): Set<string> {
  const handle = (h: string) => wf.edges.filter((e) => e.source === loopId && (e.sourceHandle ?? 'out') === h).map((e) => e.target);
  const each = reach(wf, handle('each'));
  const done = reach(wf, handle('done'));
  for (const id of done) each.delete(id);
  return each;
}

const clip = (v: unknown): unknown => {
  const s = JSON.stringify(v);
  return s && s.length > 20_000 ? { truncated: s.slice(0, 20_000) } : v;
};

const summarize = (out: Record<string, any>): unknown => out.value ?? out.text ?? out;

const UNIT_MS: Record<string, number> = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };
/** When a Wait step ends. Pure; tested. */
export function waitUntil(cfg: Record<string, any>, scope: Record<string, any>, now: Date): Date {
  if (cfg.mode === 'Until a date and time') {
    const raw = String(cfg.until ?? '').replace(/\{\{\s*([\w.[\]]+)\s*\}\}/g, (_m, p: string) => String(resolveRaw(`{{${p}}}`, scope) ?? ''));
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) throw new Error(`Wait: "${raw || 'empty'}" is not a date`);
    return d;
  }
  const amount = Math.max(0, Number(cfg.amount ?? 1));
  return new Date(now.getTime() + amount * (UNIT_MS[String(cfg.unit ?? 'days')] ?? UNIT_MS.days));
}

export async function execute(
  wf: Workflow,
  env: Env,
  st: RunState,
  subset?: Set<string>,
  nested = false,
): Promise<Outcome> {
  const order = topoOrder(wf).filter((id) => !subset || subset.has(id));
  const inOrder = new Set(order);
  const nodes = new Map(wf.nodes.map((n) => [n.id, n]));

  // Loop bodies are run by their loop node, not by the outer pass.
  const owned = new Set<string>();
  for (const id of order) {
    if (nodes.get(id)!.type === 'logic.loop') for (const b of loopBody(wf, id)) if (inOrder.has(b)) owned.add(b);
  }

  for (; st.cursor < order.length; st.cursor++) {
    const id = order[st.cursor];
    if (owned.has(id)) continue;
    const node = nodes.get(id)!;
    const isTrigger = node.type.startsWith('trigger.');
    const incoming = wf.edges.filter((e) => e.target === id);
    const active = (isTrigger && !nested) || incoming.some((e) => st.active.includes(e.id));
    if (!active) continue;
    if (st.steps.length > MAX_STEPS) return { status: 'error', error: 'Too many steps' };

    const label = node.label || node.type;
    const t0 = Date.now();
    let result: NodeResult;
    try {
      if (node.type === 'logic.approval') {
        if (nested) throw new Error('Approval is not supported inside a loop');
        if (env.dryRun) {
          // Preview: show what would be asked and continue as if approved.
          const { render } = await import('./template.js');
          result = { output: { approved: true, wouldDo: 'Ask for approval', message: render(node.config.message, st.scope) }, handles: ['approved'] };
        } else {
          if (st.decision?.nodeId !== id) {
            st.pending = id;
            const { render } = await import('./template.js');
            st.steps.push({ nodeId: id, type: node.type, label, status: 'waiting', output: { message: render(node.config.message, st.scope) }, ms: 0 });
            return { status: 'waiting' };
          }
          const approved = st.decision.approve;
          st.decision = undefined;
          st.pending = undefined;
          st.steps = st.steps.filter((s) => !(s.nodeId === id && s.status === 'waiting'));
          result = { output: { approved }, handles: [approved ? 'approved' : 'rejected'] };
        }
      } else if (node.type === 'logic.wait') {
        const until = waitUntil(node.config, st.scope, new Date());
        if (env.dryRun) result = { output: { waitedUntil: until.toISOString(), wouldDo: `Wait until ${until.toUTCString()}` } };
        else if (st.woke === id) { st.woke = undefined; st.sleepUntil = undefined; result = { output: { waitedUntil: until.toISOString() } }; }
        else {
          if (nested) throw new Error('A Wait step inside a loop is not supported.');
          if (until.getTime() <= Date.now()) result = { output: { waitedUntil: until.toISOString() } };
          else {
            st.sleepUntil = until.toISOString();
            st.pending = id;
            st.steps.push({ nodeId: id, type: node.type, label, status: 'waiting', output: { message: `Waiting until ${until.toUTCString()}` }, ms: 0 });
            return { status: 'sleeping' };
          }
        }
      } else if (node.type === 'logic.loop') {
        result = await runLoop(wf, node, env, st);
      } else {
        const exec = EXECUTORS[node.type];
        if (!exec) throw new Error(`No executor for ${node.type}`);
        // A person's decision on this step (it asked first, or a rule needed approval).
        let approved = false;
        if (st.decision?.nodeId === id) {
          const ok = st.decision.approve;
          st.decision = undefined;
          st.pending = undefined;
          st.steps = st.steps.filter((s) => !(s.nodeId === id && s.status === 'waiting'));
          if (!ok) {
            st.steps.push({ nodeId: id, type: node.type, label, status: 'ok', output: { approved: false, skipped: true }, ms: 0 });
            st.final = `Not approved: "${label}" was not run. Nothing was changed.`;
            return { status: 'done' };
          }
          approved = true;
        }
        const pause = async (reason: string): Promise<Outcome> => {
          if (nested) throw new Error(`"${label}" needs approval, which isn't supported inside a loop. Add one approval step before the loop instead.`);
          // Describe exactly what would happen, with real values, by running the step in preview.
          const preview = await exec(node, st.scope, { ...env, dryRun: true, approved: true }).catch(() => null);
          const what = preview?.output?.wouldDo ? `${preview.output.wouldDo}${preview.output.fields || preview.output.inputs ? `: ${JSON.stringify(preview.output.fields ?? preview.output.inputs)}` : ''}` : label;
          st.pending = id;
          st.steps.push({ nodeId: id, type: node.type, label, status: 'waiting', output: { message: `${reason}\n- ${what}` }, ms: 0 });
          return { status: 'waiting' };
        };
        if (!env.dryRun && !approved && WRITE_NODE_TYPES.includes(node.type) && node.config.askFirst === 'Yes') return await pause(`Approve "${label}"?`);
        try {
          result = await exec(node, st.scope, approved ? { ...env, approved: true } : env);
        } catch (e) {
          if (!(e instanceof ApprovalRequired)) throw e;
          if (env.dryRun) {
            // Preview: note that it would ask, and show the rest as if approved.
            result = await exec(node, st.scope, { ...env, approved: true });
            result.output = { ...result.output, wouldDo: `Ask for approval (${e.message}), then ${String(result.output.wouldDo ?? label)}` };
          } else return await pause(e.message);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      st.steps.push({ nodeId: id, type: node.type, label, status: 'error', error: msg, ms: Date.now() - t0 });
      if (node.config.continueOnError) {
        st.scope[id] = { error: msg };
        for (const e of wf.edges) if (e.source === id) st.active.push(e.id);
        if (!nested) await env.checkpoint?.({ ...st, cursor: st.cursor + 1 });
        continue;
      }
      return { status: 'error', error: `${label}: ${msg}` };
    }

    st.scope[id] = result.output;
    if (result.usage) {
      st.usage = addUsage(st.usage ?? emptyUsage(), result.usage);
      st.tokens += totalTokens(result.usage);
    }
    if (node.type === 'logic.wait') st.steps = st.steps.filter((s) => !(s.nodeId === id && s.status === 'waiting'));
    st.steps.push({ nodeId: id, type: node.type, label, status: 'ok', output: clip(result.output), ms: Date.now() - t0, trace: result.trace,
      ...(result.reused ? { reused: true } : {}),
      ...(result.usage && (result.usage.costUsd || totalTokens(result.usage)) ? { ai: { tokens: totalTokens(result.usage), costUsd: result.usage.costUsd } } : {}) });
    if (node.type !== 'logic.loop' && !isTrigger) st.last = summarize(result.output);
    if (node.type === 'util.output') st.final = result.output.value;

    for (const e of wf.edges) {
      if (e.source !== id) continue;
      if (!result.handles || result.handles.includes(e.sourceHandle ?? 'out')) st.active.push(e.id);
    }
    // Progress is saved with the cursor past this step, so a resume never repeats a finished step.
    if (!nested) await env.checkpoint?.({ ...st, cursor: st.cursor + 1 });
  }
  return { status: 'done' };
}

const BATCHABLE = new Set(['sf.updateRecord', 'sf.createRecord', 'sf.createTask']);

async function runLoop(wf: Workflow, node: WFNode, env: Env, st: RunState): Promise<NodeResult> {
  let items = resolveRaw(node.config.items, st.scope);
  if (typeof items === 'string') {
    try { items = JSON.parse(items); } catch { /* handled below */ }
  }
  if (!Array.isArray(items)) throw new Error('List must be an array, e.g. {{sf_query_1.records}}');
  const max = Math.min(Math.max(Number(node.config.max) || 20, 1), 100);
  const body = loopBody(wf, node.id);
  const eachEdges = wf.edges.filter((e) => e.source === node.id && (e.sourceHandle ?? 'out') === 'each').map((e) => e.id);

  // Writes in the loop are collected and sent together at the end: up to 200 records per API call instead of
  // one call each. Only steps whose output nothing reads can wait (a created record's Id isn't known until then).
  const defer = new Set<string>([...body].filter((id) => {
    const n = wf.nodes.find((x) => x.id === id);
    if (!n || !BATCHABLE.has(n.type)) return false;
    return !wf.nodes.some((o) => o.id !== id && JSON.stringify(o.config).includes(`{{${id}.`));
  }));
  const writes: WriteBuffer | undefined = defer.size && !env.dryRun ? { defer, ops: [], item: 0 } : undefined;
  const loopEnv = writes ? { ...env, writes } : env;

  const results: unknown[] = [];
  for (const [i, item] of items.slice(0, max).entries()) {
    const sub: RunState = { scope: { ...st.scope, item, index: i }, active: [...eachEdges], steps: [], cursor: 0, tokens: 0, usage: emptyUsage() };
    if (writes) writes.item = i;
    const out = await execute(wf, loopEnv, sub, body, true);
    for (const s of sub.steps) st.steps.push({ ...s, iteration: i });
    st.tokens += sub.tokens;
    st.usage = addUsage(st.usage ?? emptyUsage(), sub.usage ?? emptyUsage());
    if (out.status !== 'done') throw new Error(`item ${i + 1}: ${out.error ?? out.status}`);
    results.push(sub.final ?? sub.last ?? null);
  }
  if (writes?.ops.length) {
    const saved = await env.sf.saveMany(writes.ops);
    const failed = saved.map((r, j) => ({ r, op: writes.ops[j] })).filter((x) => !x.r.ok);
    if (failed.length) {
      const first = failed.slice(0, 3).map((f) => `item ${f.op.item + 1} (${f.op.label}): ${f.r.error}`).join('; ');
      throw new Error(`${saved.length - failed.length} of ${saved.length} changes saved; ${failed.length} failed: ${first}${failed.length > 3 ? '; …' : ''}`);
    }
    return { output: { results, count: results.length, saved: saved.length }, handles: ['done'] };
  }
  return { output: { results, count: results.length }, handles: ['done'] };
}
