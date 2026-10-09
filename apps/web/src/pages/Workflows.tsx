import { LayoutTemplate, Loader2, Plus, Sparkles, Workflow as WorkflowIcon, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { TEMPLATES, type Workflow } from '@crmagents/shared';
import { api, type Draft as AiDraft, type Tenant, type WorkflowRow } from '../api';
import { NodeTile } from '../components/nodeIcons';
import { WorkflowEditor } from '../components/WorkflowEditor';
import { AgentsPage } from './Agents';

interface Draft { key: string; id: string | null; name: string; graph: Workflow; ai?: AiDraft; live?: boolean }

const EXAMPLES = [
  'When a new case comes in, sort it into installation, breakdown, performance or other and create a follow-up task. Skip closed cases.',
  'Score new leads from 0 to 100 and create a call task for the hot ones',
  'Summarize an account: open opportunities, open cases and next steps',
  'List hot leads nobody has contacted yet',
];
const blank: Workflow = { nodes: [], edges: [] };

const triggerLabel = (g: Workflow) => {
  const t = g.nodes.find((n) => n.type.startsWith('trigger.'));
  if (!t) return 'No trigger';
  if (t.type === 'trigger.schedule') return `Every ${t.config.every ?? 'day'}`;
  if (t.type === 'trigger.salesforce') return t.config.objectApiName ? `On ${t.config.objectApiName}` : 'Salesforce record';
  return 'Manual / API';
};

const ago = (iso: string) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
};

function TemplatePicker({ onPick, onClose }: { onPick: (name: string, g: Workflow) => void; onClose: () => void }) {
  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h3>New agent</h3>
            <p className="muted small" style={{ margin: '4px 0 0' }}>Start from a template or an empty canvas. You can change everything later.</p>
          </div>
          <button className="ghost icon" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="tpl-grid">
          <button className="tpl" onClick={() => onPick('Untitled workflow', blank)}>
            <span className="tile" style={{ background: 'var(--surface-2)', color: 'var(--text-2)' }}><Plus size={15} /></span>
            <b>Blank canvas</b>
            <span className="muted small">Build from scratch.</span>
          </button>
          {TEMPLATES.map((t) => (
            <button key={t.id} className="tpl" onClick={() => onPick(t.name, structuredClone(t.workflow))}>
              <div className="row" style={{ gap: 4 }}>
                {[...new Set(t.workflow.nodes.map((n) => n.type))].slice(0, 4).map((type) => <NodeTile key={type} type={type} />)}
              </div>
              <b>{t.name}</b>
              <span className="muted small">{t.description}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function WorkflowsPage({ tenant, goConnections, incoming, onIncomingOpened, prefill, onPrefillUsed }: {
  tenant?: Tenant; goConnections: () => void; incoming?: AiDraft | null; onIncomingOpened?: () => void; prefill?: string | null; onPrefillUsed?: () => void;
}) {
  const [section, setSection] = useState<'automations' | 'assistants'>('automations');
  const [rows, setRows] = useState<WorkflowRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [cur, setCur] = useState<Draft | null>(null);
  const [picker, setPicker] = useState(false);
  const [err, setErr] = useState('');
  const [request, setRequest] = useState('');
  const [building, setBuilding] = useState(false);

  const load = () => tenant && api.workflows(tenant.id).then(setRows).catch((e) => setErr(e.message)).finally(() => setLoaded(true));
  useEffect(() => { setCur(null); setLoaded(false); load(); }, [tenant?.id]);
  // "Fix with an agent" from Insights: put the request in the describe box, ready to build.
  useEffect(() => {
    if (!prefill) return;
    setSection('automations'); setCur(null); setRequest(prefill);
    onPrefillUsed?.();
    setTimeout(() => document.getElementById('describe-agent')?.focus(), 50);
  }, [prefill]);
  // A draft built from Home opens straight in the editor.
  useEffect(() => {
    if (!incoming) return;
    setCur({ key: crypto.randomUUID(), id: null, name: incoming.name, graph: incoming.workflow, ai: incoming });
    onIncomingOpened?.();
  }, [incoming]);

  if (!tenant) {
    return (
      <div className="page" style={{ overflow: 'auto', height: '100%' }}>
        <div className="empty">
          <span className="empty-icon"><WorkflowIcon size={20} /></span>
          <b style={{ color: 'var(--text)' }}>Connect a Salesforce org to start building</b>
          <span>Workflows run against a connected org.</span>
          <button className="primary" onClick={goConnections}>Connect Salesforce</button>
        </div>
      </div>
    );
  }

  if (cur) {
    return (
      <WorkflowEditor
        key={cur.key} tenantId={tenant.id} id={cur.id} initialName={cur.name} initialGraph={cur.graph} aiDraft={cur.ai} initialLive={!!cur.live}
        onBack={() => { setCur(null); load(); }}
        onSaved={(id) => { setCur((c) => c && { ...c, id }); load(); }}
        onDeleted={() => { setCur(null); load(); }}
      />
    );
  }

  const build = async () => {
    if (!tenant || request.trim().length < 5) return;
    setBuilding(true); setErr('');
    try {
      const d = await api.draftWorkflow(tenant.id, request.trim());
      setCur({ key: crypto.randomUUID(), id: null, name: d.name, graph: d.workflow, ai: d });
      setRequest('');
    } catch (e) { setErr((e as Error).message); }
    finally { setBuilding(false); }
  };

  const create = (name: string, graph: Workflow) => { setCur({ key: crypto.randomUUID(), id: null, name, graph }); setPicker(false); };

  return (
    <div style={{ overflow: 'auto', height: '100%' }}>
      <div className="page">
        <div className="page-head">
          <div>
            <h2>Agents</h2>
            <p>Agents for <b>{tenant.sf_username ?? tenant.sf_org_id}</b>. Automations run by themselves in Salesforce; assistants answer questions when you ask.</p>
          </div>
          <button className="primary" onClick={() => setPicker(true)}><Plus size={15} /> From a template</button>
        </div>
        <div className="seg" style={{ marginBottom: 16 }}>
          <button className={section === 'automations' ? 'on' : ''} onClick={() => setSection('automations')}>Automations</button>
          <button className={section === 'assistants' ? 'on' : ''} onClick={() => setSection('assistants')}>Assistants</button>
        </div>
        {section === 'assistants' && <AgentsPage tenant={tenant} goConnections={goConnections} />}
        {section === 'automations' && <>
        <div className="card builder-hero">
          <div className="row"><Sparkles size={18} color="var(--accent)" /><h3>Describe what you want</h3></div>
          <textarea
            id="describe-agent" rows={3} value={request} onChange={(e) => setRequest(e.target.value)} disabled={building}
            placeholder="e.g. When a new case comes in, sort it by type and create a follow-up task for the owner. Skip closed cases."
            onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') void build(); }}
          />
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            {EXAMPLES.map((x) => <button key={x} className="chip example" onClick={() => setRequest(x)} disabled={building}>{x.length > 60 ? `${x.slice(0, 58)}…` : x}</button>)}
          </div>
          <div className="row">
            <button className="primary" onClick={build} disabled={building || request.trim().length < 5}>
              {building ? <><Loader2 size={15} className="spin" /> Reading your org and building…</> : <><Sparkles size={15} /> Build it</>}
            </button>
            <span className="muted small">Uses your org's real objects and fields. You review it before anything runs.</span>
          </div>
        </div>
        {err && <div className="card warn">{err}</div>}

        {loaded && rows.length === 0 ? (
          <div className="empty">
            <span className="empty-icon"><LayoutTemplate size={20} /></span>
            <b style={{ color: 'var(--text)' }}>No agents yet</b>
            <span>Describe one above, or start from a template like case triage or lead scoring.</span>
            <button className="primary" onClick={() => setPicker(true)}><Plus size={15} /> From a template</button>
          </div>
        ) : (
          <div className="wf-grid">
            {rows.map((w) => {
              const types = [...new Set(w.graph.nodes.map((n) => n.type))];
              return (
                <button key={w.id} className="wf-card" onClick={() => setCur({ key: w.id, id: w.id, name: w.name, graph: w.graph, live: !!w.live })}>
                  <div className="icon-strip">
                    {types.slice(0, 5).map((t) => <NodeTile key={t} type={t} />)}
                    {types.length > 5 && <span className="badge">+{types.length - 5}</span>}
                  </div>
                  <div className="wf-card-title">{w.name}</div>
                  <div className="wf-card-meta">
                    <span className="badge accent">{triggerLabel(w.graph)}</span>
                    {w.live && !w.watch_error && <span className="badge ok">● On</span>}
                    {w.live && w.watch_error && <span className="badge err" title={w.watch_error}>● Problem</span>}
                    <span className="badge">{w.graph.nodes.length} blocks</span>
                    <span className="muted small" style={{ marginLeft: 'auto' }}>{ago(w.updated_at)}</span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
        </>}
      </div>
      {picker && <TemplatePicker onPick={create} onClose={() => setPicker(false)} />}
    </div>
  );
}
