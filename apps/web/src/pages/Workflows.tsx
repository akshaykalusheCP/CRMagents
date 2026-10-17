import { LayoutTemplate, Plus, Upload, Workflow as WorkflowIcon, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { TEMPLATES, type Workflow } from '@crmagents/shared';
import { AgentBuilder } from '../components/AgentBuilder';
import { UseCaseLibrary } from '../components/UseCaseLibrary';
import { Empty, FilterTabs, PageHeader, Panel, SkeletonRows, Status, Table, toast, type Column } from '../components/ui';
import { Ribbon } from '../components/Ribbon';
import { api, type AgentHealth, type Draft as AiDraft, type Tenant, type WorkflowRow } from '../api';
import { NodeTile } from '../components/nodeIcons';
import { WorkflowEditor } from '../components/WorkflowEditor';
import { AgentsPage } from './Agents';
import { AgentPage } from './Agent';

interface Draft { key: string; id: string | null; name: string; graph: Workflow; ai?: AiDraft; live?: boolean; realtime?: boolean }

const blank: Workflow = { nodes: [], edges: [] };

const triggerLabel = (g: Workflow) => {
  const t = g.nodes.find((n) => n.type.startsWith('trigger.'));
  if (!t) return 'No trigger';
  if (t.type === 'trigger.schedule') return `Every ${t.config.every ?? 'day'}`;
  if (t.type === 'trigger.salesforce') return t.config.objectApiName ? `On ${t.config.objectApiName}` : 'Salesforce record';
  return 'Manual / API';
};

const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)}h ago`;
  if (m < 60 * 24 * 30) return `${Math.round(m / 1440)}d ago`;
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
};

function TemplatePicker({ onPick, onClose }: { onPick: (name: string, g: Workflow) => void; onClose: () => void }) {
  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h3 style={{ margin: 0 }}>Start from a template</h3>
            <p className="muted small" style={{ margin: '4px 0 0' }}>Ready-made agents you can adjust, or a blank canvas. Nothing runs until you turn it on.</p>
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
  const [detail, setDetail] = useState<WorkflowRow | null>(null);
  const [picker, setPicker] = useState(false);
  const [library, setLibrary] = useState(false);
  const [err, setErr] = useState('');
  const [request, setRequest] = useState('');
  const [builder, setBuilder] = useState<{ first?: string } | null>(null);
  const [filter, setFilter] = useState<'all' | 'on' | 'off' | 'problem'>('all');
  const [health, setHealth] = useState<Record<string, AgentHealth>>({});

  const importRef = useRef<HTMLInputElement>(null);
  const load = () => tenant && api.workflows(tenant.id).then((r) => { setRows(r); setDetail((d) => d && (r.find((x) => x.id === d.id) ?? null)); }).catch((e) => setErr(e.message)).finally(() => setLoaded(true));
  useEffect(() => { setCur(null); setDetail(null); setBuilder(null); setLoaded(false); load(); if (tenant) api.agentHealth(tenant.id).then((h) => setHealth(Object.fromEntries(h.map((x) => [x.workflowId, x])))).catch(() => {}); }, [tenant?.id]);
  // "Fix with an agent" from Insights: put the request in the describe box, ready to build.
  useEffect(() => {
    if (!prefill) return;
    setSection('automations'); setCur(null); setBuilder({ first: prefill });
    onPrefillUsed?.();
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
        key={cur.key} tenantId={tenant.id} id={cur.id} initialName={cur.name} initialGraph={cur.graph} aiDraft={cur.ai} initialLive={!!cur.live} initialRealtime={!!cur.realtime}
        onBack={() => { setCur(null); load(); }}
        onSaved={(id) => { setCur((c) => c && { ...c, id }); load(); }}
        onDeleted={() => { setCur(null); load(); }}
      />
    );
  }

  if (detail) {
    return (
      <div style={{ overflow: 'auto', height: '100%' }}>
        <AgentPage tenant={tenant} row={detail} onBack={() => { setDetail(null); load(); }}
          onEdit={() => setCur({ key: detail.id, id: detail.id, name: detail.name, graph: detail.graph, live: !!detail.live, realtime: !!detail.realtime })}
          onChanged={(w) => { setDetail((d) => d && { ...d, ...w }); setRows((r) => r.map((x) => (x.id === detail.id ? { ...x, ...w } : x))); }}
          onDeleted={() => { setDetail(null); load(); }} />
      </div>
    );
  }

  if (builder) {
    return (
      <AgentBuilder tenantId={tenant.id} first={builder.first} onBack={() => setBuilder(null)}
        onOpen={(d) => { setBuilder(null); setCur({ key: crypto.randomUUID(), id: null, name: d.name, graph: d.workflow, ai: d }); }} />
    );
  }

  const start = () => { setBuilder({ first: request.trim() || undefined }); setRequest(''); };

  const create = (name: string, graph: Workflow) => { setCur({ key: crypto.randomUUID(), id: null, name, graph }); setPicker(false); };

  const counts = { all: rows.length, on: rows.filter((w) => w.live && !w.watch_error).length, off: rows.filter((w) => !w.live).length, problem: rows.filter((w) => (w.live && w.watch_error) || w.paused_reason).length };
  const shown = rows.filter((w) => filter === 'all' || (filter === 'on' ? w.live && !w.watch_error : filter === 'off' ? !w.live : (w.live && !!w.watch_error) || !!w.paused_reason));
  const open = (w: WorkflowRow) => setDetail(w);
  const columns: Column<WorkflowRow>[] = [
    { key: 'name', header: 'Agent', render: (w) => {
      const types = [...new Set(w.graph.nodes.map((n) => n.type))].filter((t) => !t.startsWith('trigger.') && t !== 'util.output').slice(0, 4);
      return (
        <div className="agent-cell">
          <div className="icon-strip">{types.map((t) => <NodeTile key={t} type={t} />)}</div>
          <div className="cell-main"><b>{w.name}</b><span className="cell-sub">{triggerLabel(w.graph)}</span></div>
        </div>
      );
    } },
    { key: 'status', header: 'Status', render: (w) => w.live
      ? (w.watch_error ? <Status tone="bad" title={w.watch_error}>Problem</Status> : <Status tone="ok">On</Status>)
      : w.paused_reason ? <Status tone="bad" title={w.paused_reason}>Paused</Status> : <Status tone="neutral">Off</Status> },
    { key: 'health', header: 'Last 30 days', hideSm: true, render: (w) => {
      const h = health[w.id];
      if (!h || !h.runs) return <span className="muted">No runs</span>;
      const rate = Math.round((h.succeeded / Math.max(h.runs - h.waiting, 1)) * 100);
      return (
        <div className="cell-main">
          <span>{h.runs} run{h.runs === 1 ? '' : 's'} · <span style={{ color: rate >= 90 ? 'var(--ok)' : rate >= 70 ? 'var(--warn)' : 'var(--danger)' }}>{rate}% ok</span></span>
          {h.suggestion && <span className="cell-sub">{h.suggestion.kind === 'drop_approval' ? 'Ready to run on its own' : h.suggestion.title}</span>}
        </div>
      );
    } },
    { key: 'steps', header: 'Steps', align: 'right', hideSm: true, render: (w) => <span className="muted">{w.graph.nodes.filter((n) => n.type !== 'util.output').length}</span> },
    { key: 'updated', header: 'Updated', align: 'right', render: (w) => <span className="muted">{ago(w.updated_at)}</span> },
  ];

  return (
    <div style={{ overflow: 'auto', height: '100%' }}>
      <div className="pg">
        <PageHeader
          title="Agents"
          description={<>Automations run by themselves in <b style={{ color: 'var(--text)', fontWeight: 500 }}>{tenant.sf_username ?? tenant.sf_org_id}</b>; assistants answer questions when you ask.</>}
          actions={<>
            <button onClick={() => setLibrary(true)}><LayoutTemplate size={15} /> Use cases</button>
            <button onClick={() => importRef.current?.click()} title="Add an agent from a .crmagents.json file (exported from another org)"><Upload size={15} /> Import</button>
              <input ref={importRef} type="file" accept=".json,application/json" hidden onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                try {
                  const data = JSON.parse(await f.text());
                  if (!data?.graph?.nodes) throw new Error('This is not a CRMagents agent file');
                  const r = await api.importAgent(tenant.id, { name: String(data.name || f.name.replace(/\.crmagents\.json$|\.json$/, '')), graph: data.graph });
                  toast(r.missing.length ? `Imported (off). Missing in this org: ${r.missing.slice(0, 4).join(', ')}${r.missing.length > 4 ? '…' : ''}` : 'Imported (turned off)', r.missing.length ? 'bad' : 'ok');
                  load();
                } catch (err) { toast((err as Error).message, 'bad'); }
              }} />

            <button className="primary cta" onClick={() => setBuilder({})}><Plus size={15} /> New agent</button>
          </>}
        >
          <div className="ptabs" role="tablist">
            <button role="tab" aria-selected={section === 'automations'} className={section === 'automations' ? 'on' : ''} onClick={() => setSection('automations')}>Automations</button>
            <button role="tab" aria-selected={section === 'assistants'} className={section === 'assistants' ? 'on' : ''} onClick={() => setSection('assistants')}>Assistants</button>
          </div>
        </PageHeader>

        {section === 'assistants' && <AgentsPage tenant={tenant} goConnections={goConnections} />}
        {section === 'automations' && <>
          {err && <div className="card warn">{err}</div>}
          {loaded && rows.length === 0 ? (
            <form className="start-panel builder-hero" onSubmit={(e) => { e.preventDefault(); start(); }}>
              <Ribbon className="card-ribbon" strands={180} angle={0.55} width={0.55} />
              <div className="start-copy">
                <h2>Build your first agent</h2>
                <p>Describe what it should do. I'll ask a quick question if something's missing, use your org's real fields, Flows and Apex, and nothing runs until you approve it.</p>
              </div>
              <div className="agent-start">
                <input id="describe-agent" value={request} onChange={(e) => setRequest(e.target.value)} placeholder="e.g. Sort new cases by type and create a follow-up task for the owner" />
                <button type="submit" className="primary cta">Start</button>
              </div>
              <button type="button" className="link-btn" onClick={() => setPicker(true)}>Or start from a template</button>
            </form>
          ) : (
            <>
              <FilterTabs value={filter} onChange={setFilter} options={[
                { id: 'all', label: 'All', count: counts.all }, { id: 'on', label: 'On', count: counts.on },
                { id: 'off', label: 'Off', count: counts.off }, ...(counts.problem ? [{ id: 'problem' as const, label: 'Problems', count: counts.problem }] : []),
              ]} />
              <Panel flush>
                {!loaded ? <SkeletonRows rows={4} cols={4} /> : <Table columns={columns} rows={shown} rowKey={(w) => w.id} onRowClick={open}
                  empty={<Empty title="No agents match this filter" />} />}
              </Panel>
            </>
          )}
        </>}
      </div>
      {picker && <TemplatePicker onPick={create} onClose={() => setPicker(false)} />}
      {library && <UseCaseLibrary onClose={() => setLibrary(false)} onTemplates={() => { setLibrary(false); setPicker(true); }}
        onPick={(request) => { setLibrary(false); setSection('automations'); setBuilder({ first: request }); }} />}
    </div>
  );
}
