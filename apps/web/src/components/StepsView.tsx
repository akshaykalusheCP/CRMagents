import type { Edge } from '@xyflow/react';
import { CheckCircle2, CornerDownRight, PauseCircle, Plus, XCircle } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { CATEGORY_COLORS, NODE_DEFS, NODE_DEF_BY_TYPE, type Category } from '@crmagents/shared';
import { NodeTile } from './nodeIcons';
import type { WFRFNode } from './WorkflowNode';

// The admin-friendly view of an agent: one plain-English sentence per step, top to bottom, data shown as pills.
// Editing happens in the side panel; the free-form canvas stays available as the advanced view.

interface Props {
  nodes: WFRFNode[];
  edges: Edge[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onAdd: (type: string) => void;
}

const OP: Record<string, string> = {
  equals: 'is', not_equals: 'is not', contains: 'contains', greater_than: 'is more than', less_than: 'is less than', is_empty: 'is empty', not_empty: 'is not empty',
};

/** Friendly name for a node, used as the first part of a data pill. */
function sourceName(n: WFRFNode | undefined): string {
  if (!n) return 'Step';
  const c = n.data.config;
  switch (n.data.type) {
    case 'sf.getRecord': return String(c.sobject || 'Record');
    case 'ai.classify': return 'AI decision';
    case 'ai.extract': return 'AI extracted';
    case 'ai.agent': return 'AI';
    case 'sf.query': return 'Found records';
    case 'sf.createTask': return 'New task';
    case 'sf.createRecord': return `New ${c.sobject || 'record'}`;
    case 'logic.loop': return 'Loop';
    default: return n.data.label || NODE_DEF_BY_TYPE[n.data.type]?.label || n.id;
  }
}

const KEY_LABEL: Record<string, string> = { recordId: 'Record ID', input: 'Input text', objectApiName: 'Object', context: 'Context', category: 'category', totalSize: 'count', table: 'table' };

/** Renders text with {{references}} as readable pills. */
export function withPills(text: string, byId: Map<string, WFRFNode>): ReactNode[] {
  const parts = String(text ?? '').split(/(\{\{\s*[\w.[\]]+\s*\}\})/g);
  return parts.filter((p) => p !== '').map((p, i) => {
    const m = /^\{\{\s*([\w.[\]]+)\s*\}\}$/.exec(p);
    if (!m) return <span key={i}>{p}</span>;
    const [head, ...rest] = m[1].split('.');
    const path = rest.filter((x) => x !== 'record' && x !== 'data' && x !== 'first');
    let label: string;
    if (head === 'trigger') label = KEY_LABEL[path[0]] ?? path.join(' › ');
    else if (head === 'item' || head === 'index') label = ['This record', ...path].join(' › ');
    else label = [sourceName(byId.get(head)), ...path.map((x) => KEY_LABEL[x] ?? x)].join(' › ');
    return <span key={i} className="pill" title={m[1]}>{label}</span>;
  });
}

const firstText = (s: unknown, n = 140) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** The sentence and the detail line for one step. */
function describe(n: WFRFNode, byId: Map<string, WFRFNode>, exitsElsewhere: boolean): { title: ReactNode; detail?: ReactNode } {
  const c = n.data.config;
  const P = (t: unknown) => withPills(firstText(t), byId);
  switch (n.data.type) {
    case 'trigger.salesforce': return { title: <>When a <b>{c.objectApiName || 'record'}</b> is {c.event === 'created or updated' ? 'created or updated' : 'created'}</>, detail: 'In Salesforce, checked every minute once the agent is turned on' };
    case 'trigger.manual': return { title: 'When you run it', detail: 'Manually, from a test or through the API' };
    case 'trigger.schedule': {
      const every = String(c.every ?? 'day');
      return { title: <>Every <b>{every}</b>{every !== 'hour' && <> at <b>{c.at || '08:00'}</b> UTC</>}{every === 'week' && ' on Mondays'}</>, detail: 'Once the agent is turned on' };
    }
    case 'sf.getRecord': return { title: <>Look up the <b>{c.sobject || 'record'}</b></>, detail: c.fields ? `Fields: ${c.fields}` : 'All fields' };
    case 'logic.branch': {
      const cond = <>{P(c.left)} <b>{OP[c.operator] ?? c.operator}</b> {c.operator === 'is_empty' || c.operator === 'not_empty' ? null : P(c.right)}</>;
      return exitsElsewhere ? { title: <>Only do the next step if {cond}</> } : { title: <>Continue only if {cond}</> };
    }
    case 'ai.classify': return { title: <>AI decides: <b>{String(c.categories ?? '').split(/\n|,/).map((x) => x.trim()).filter(Boolean).join(', ')}</b></>, detail: <>Reads: {P(c.text)}</> };
    case 'ai.extract': return { title: <>AI pulls out: <b>{String(c.fields ?? '').split('\n').map((l) => l.split(':')[0].trim()).filter(Boolean).join(', ')}</b></>, detail: <>From: {P(c.text)}</> };
    case 'ai.agent': return (c.tools ?? []).length
      ? { title: 'AI researches in Salesforce', detail: P(c.prompt) }
      : { title: 'AI writes', detail: P(c.prompt) };
    case 'logic.approval': return { title: 'Ask someone to approve', detail: P(c.message) };
    case 'sf.createTask': return { title: <>Create a task: {P(c.subject || 'Follow up')}</>, detail: c.description ? P(c.description) : undefined };
    case 'sf.updateRecord': {
      let fields: Record<string, unknown> = {};
      try { fields = JSON.parse(String(c.fields || '{}')); } catch { /* shown raw below */ }
      const keys = Object.entries(fields);
      return { title: <>Update the <b>{c.sobject || 'record'}</b></>, detail: keys.length ? <>{keys.map(([k, v], i) => <span key={k}>{i ? ', ' : ''}{k} → {P(v)}</span>)}</> : P(c.fields) };
    }
    case 'sf.createRecord': return { title: <>Create a <b>{c.sobject || 'record'}</b></>, detail: P(c.fields) };
    case 'sf.query': {
      const from = /\bFROM\s+(\w+)/i.exec(String(c.soql ?? ''))?.[1];
      return { title: <>Find <b>{from ?? ''}</b> records</>, detail: <span className="mono">{firstText(c.soql, 120)}</span> };
    }
    case 'logic.loop': return { title: <>For each record found, do the steps below</>, detail: <>Up to {c.max ?? 20} records from {P(c.items)}</> };
    case 'notify.slack': return { title: 'Post to Slack', detail: P(c.text) };
    case 'http.request': return { title: <>Call <b>{(() => { try { return new URL(String(c.url)).host; } catch { return 'an API'; } })()}</b></>, detail: `${c.method ?? 'GET'} request` };
    case 'util.set': return { title: 'Prepare values', detail: P(c.values) };
    case 'util.output': return { title: <>Finish with: {P(c.value || 'Done')}</> };
    default: return { title: n.data.label || n.data.type };
  }
}

function order(nodes: WFRFNode[], edges: Edge[]): string[] {
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  edges.forEach((e) => indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1));
  const q = nodes.filter((n) => indeg.get(n.id) === 0).sort((a, b) => a.position.x - b.position.x).map((n) => n.id);
  const out: string[] = [];
  while (q.length) {
    const id = q.shift()!;
    out.push(id);
    edges.filter((e) => e.source === id).forEach((e) => {
      const d = (indeg.get(e.target) ?? 0) - 1;
      indeg.set(e.target, d);
      if (d === 0) q.push(e.target);
    });
  }
  // Anything not reachable (or in a cycle) still shows, at the end.
  nodes.forEach((n) => { if (!out.includes(n.id)) out.push(n.id); });
  return out;
}

const STATUS_ICON: Record<string, ReactNode> = {
  ok: <CheckCircle2 size={16} color="var(--ok)" />,
  error: <XCircle size={16} color="var(--danger)" />,
  waiting: <PauseCircle size={16} color="var(--warn)" />,
};

export function StepsView({ nodes, edges, selectedId, onSelect, onAdd }: Props) {
  const [adding, setAdding] = useState(false);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // Outputs reached only from a "false"/"rejected" handle are exits; they show under the step that leads to them.
  const exitOf = new Map<string, { node: WFRFNode; handle: string }[]>();
  const exitIds = new Set<string>();
  for (const n of nodes) {
    if (n.data.type !== 'util.output') continue;
    const inc = edges.filter((e) => e.target === n.id);
    if (inc.length && inc.every((e) => e.sourceHandle === 'false' || e.sourceHandle === 'rejected')) {
      exitIds.add(n.id);
      inc.forEach((e) => exitOf.set(e.source, [...(exitOf.get(e.source) ?? []), { node: n, handle: e.sourceHandle! }]));
    }
  }
  const steps = order(nodes, edges).filter((id) => !exitIds.has(id)).map((id) => byId.get(id)!).filter(Boolean);
  const categories = Array.from(new Set(NODE_DEFS.filter((d) => d.category !== 'Trigger').map((d) => d.category))) as Category[];

  if (!nodes.length) return null;
  return (
    <div className="steps">
      {steps.map((n, i) => {
        // A branch whose "false" side continues to a real step (not an exit) makes only the next step conditional.
        const falseToStep = edges.some((e) => e.source === n.id && e.sourceHandle === 'false' && !exitIds.has(e.target));
        const d = describe(n, byId, falseToStep);
        const exits = exitOf.get(n.id) ?? [];
        return (
          <div key={n.id} className="step-wrap">
            {i > 0 && <div className="step-line" />}
            <button className={'step-card' + (selectedId === n.id ? ' sel' : '') + (n.data.status === 'skipped' ? ' dim' : '')} onClick={() => onSelect(n.id)}>
              <span className="step-num">{i + 1}</span>
              <NodeTile type={n.data.type} />
              <span className="step-text">
                <span className="step-title">{d.title}</span>
                {d.detail && <span className="step-detail">{d.detail}</span>}
              </span>
              {n.data.status && STATUS_ICON[n.data.status]}
            </button>
            {exits.map((x) => (
              <div key={x.node.id} className="step-exit" onClick={() => onSelect(x.node.id)}>
                <CornerDownRight size={14} />
                <span>{x.handle === 'rejected' ? 'If not approved' : 'Otherwise'}: {withPills(firstText(x.node.data.config.value, 120), byId)}</span>
              </div>
            ))}
          </div>
        );
      })}
      <div className="step-wrap">
        <div className="step-line" />
        {adding ? (
          <div className="add-menu">
            {categories.map((c) => (
              <div key={c}>
                <div className="pal-cat"><i style={{ background: CATEGORY_COLORS[c] }} />{c}</div>
                <div className="add-grid">
                  {NODE_DEFS.filter((d) => d.category === c).map((d) => (
                    <button key={d.type} className="add-item" onClick={() => { onAdd(d.type); setAdding(false); }} title={d.description}>
                      <NodeTile type={d.type} /> {d.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <button className="ghost sm" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        ) : (
          <button className="add-step" onClick={() => setAdding(true)}><Plus size={15} /> Add a step</button>
        )}
      </div>
    </div>
  );
}
