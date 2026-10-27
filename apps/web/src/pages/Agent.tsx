import { ChangesList } from '../components/Changes';
import { ArrowLeft, ChevronRight, History, Loader2, Pencil, Power, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { Edge } from '@xyflow/react';
import { api, type AgentHealth, type BacktestResult, type Forecast, type Run, type Tenant, type WorkflowRow } from '../api';
import { BacktestView, ResultModal, Working } from '../components/Smart';
import { StepsView } from '../components/StepsView';
import type { WFRFNode } from '../components/WorkflowNode';
import { Empty, Facts, Meter, Panel, Status, Table, toast, useConfirm, type Column } from '../components/ui';
import { runLabel, runTone } from './Home';
import { RunsPage } from './Runs';
import { BackfillPanel, LessonsPanel, MovePanel, StartMode, VersionsPanel, WebhookPanel } from '../components/AgentAdmin';

// One agent's page: what it does in plain English, how it has been doing, its runs and its settings.
// Editing the steps opens the editor; everything else happens here.

type TabId = 'overview' | 'runs' | 'settings';
const money = (v: number) => (v > 0 && v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);
const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function triggerText(w: WorkflowRow) {
  const t = w.graph.nodes.find((n) => n.type.startsWith('trigger.'));
  if (!t) return 'No trigger yet';
  if (t.type === 'trigger.schedule') return `Every ${t.config.every ?? 'day'}${t.config.every === 'hour' ? '' : ` at ${t.config.at ?? '08:00'} ${t.config.tz || 'UTC'}`}`;
  if (t.type === 'trigger.webhook') return 'When another system calls its web address';
  if (t.type === 'trigger.salesforce') {
    const changed = String(t.config.changedFields ?? '').trim();
    return `When a ${t.config.objectApiName ?? 'record'} is ${t.config.event ?? 'created'}${changed && t.config.event !== 'created' && t.config.event !== 'deleted' ? ` and ${changed.split(/\s*,\s*/).join(' or ')} changes` : ''}`;
  }
  return 'When you run it';
}

const usd = (n: number) => (n === 0 ? '$0' : n < 0.01 ? '< $0.01' : n < 10 ? `$${n.toFixed(2)}` : `$${Math.round(n).toLocaleString()}`);
/** Cost of one run: small, so more decimals. */
const usdRun = (n: number) => (n >= 0.01 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`);

/** What it costs: this month so far, the forecast, and a monthly cap it can't go over. */
function CostPanel({ tenant, workflowId }: { tenant: Tenant; workflowId: string }) {
  const [f, setF] = useState<Forecast | null>(null);
  const [cap, setCap] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setF(null); api.forecast(tenant.id, workflowId).then((x) => { setF(x); setCap(x.capUsd ? String(x.capUsd) : ''); }).catch(() => {}); }, [tenant.id, workflowId]);
  if (!f) return null;
  const save = async (v: number | null) => {
    setBusy(true);
    try { const x = await api.setCap(tenant.id, workflowId, v); setF(x); setCap(x.capUsd ? String(x.capUsd) : ''); toast(v ? `Capped at ${usd(v)} a month` : 'Cap removed'); }
    catch (e) { toast((e as Error).message, 'bad'); }
    setBusy(false);
  };
  return (
    <Panel title="Cost">
      <div className="cost-p">
        <div className="cost-now"><b>{usd(f.spentThisMonthUsd)}</b><span>this month{f.capUsd ? ` of ${usd(f.capUsd)} cap` : ''}</span></div>
        {f.capUsd ? <Meter value={f.spentThisMonthUsd} max={f.capUsd} label="Spent of cap" /> : null}
        <p className="muted small" style={{ margin: 0 }}>
          About <b style={{ color: 'var(--text)' }}>{usd(f.monthlyUsd)} a month</b>: {f.runsPerMonth.toLocaleString()} runs × {usdRun(f.perRunUsd)} ({f.perRunBasis === 'actual' ? 'its real runs' : 'estimated from its steps'}), going by {f.runsBasis}.
        </p>
        <div className="cost-cap">
          <label className="small" htmlFor={`cap-${workflowId}`}>Monthly cap</label>
          <div className="input-affix"><span>$</span><input id={`cap-${workflowId}`} value={cap} onChange={(e) => setCap(e.target.value.replace(/[^\d.]/g, ''))} placeholder={String(f.suggestedCapUsd)} inputMode="decimal" /></div>
          <button className="sm" disabled={busy || !Number(cap) || Number(cap) === f.capUsd} onClick={() => void save(Number(cap))}>Set</button>
          {f.capUsd ? <button className="sm ghost" disabled={busy} onClick={() => void save(null)}>Remove</button> : null}
        </div>
        <span className="muted small">At the cap it stops and you get an alert. AI only: Salesforce API use doesn't cost money.</span>
      </div>
    </Panel>
  );
}

/** Everything this agent changed in Salesforce over a period, with one Undo for all of it. */
function AgentChanges({ tenant, workflowId }: { tenant: Tenant; workflowId: string }) {
  const [hours, setHours] = useState(24);
  const since = new Date(Math.floor((Date.now() - hours * 3600_000) / 60_000) * 60_000).toISOString();
  return (
    <Panel title="Changes in Salesforce" action={
      <select className="sm" value={hours} onChange={(e) => setHours(Number(e.target.value))} aria-label="Period">
        <option value={1}>Last hour</option><option value={24}>Last 24 hours</option><option value={168}>Last 7 days</option><option value={720}>Last 30 days</option>
      </select>
    }>
      <ChangesList key={hours} tenant={tenant} workflowId={workflowId} since={since} compact />
    </Panel>
  );
}

export function AgentPage({ tenant, row, onBack, onEdit, onChanged, onDeleted }: {
  tenant: Tenant; row: WorkflowRow; onBack: () => void; onEdit: () => void; onChanged: (w: Partial<WorkflowRow>) => void; onDeleted: () => void;
}) {
  const [tab, setTab] = useState<TabId>('overview');
  const [health, setHealth] = useState<AgentHealth>();
  const [runs, setRuns] = useState<Run[]>([]);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [bt, setBt] = useState<BacktestResult | 'loading' | { error: string } | null>(null);
  const t = tenant.id;
  const isRecord = row.graph.nodes.some((n) => n.type === 'trigger.salesforce');
  const isWebhook = row.graph.nodes.some((n) => n.type === 'trigger.webhook');
  const canRun = isRecord || isWebhook || row.graph.nodes.some((n) => n.type === 'trigger.schedule');

  useEffect(() => {
    api.agentHealth(t).then((h) => setHealth(h.find((x) => x.workflowId === row.id))).catch(() => {});
    api.runs(t).then((r) => setRuns(r.filter((x) => x.workflow_id === row.id))).catch(() => {});
  }, [t, row.id]);

  const rf = useMemo(() => ({
    nodes: row.graph.nodes.map((n) => ({ id: n.id, type: 'card', position: n.position, data: { type: n.type, label: n.label, config: n.config } })) as WFRFNode[],
    edges: row.graph.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? 'out' })) as Edge[],
  }), [row.graph]);

  const act = async (label: string, fn: () => Promise<void>) => {
    setBusy(label); setErr('');
    try { await fn(); } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  };
  const [confirmUi, ask] = useConfirm();
  const toggleLive = () => act('live', async () => {
    // Before turning on: what it will cost a month, with the option to cap it.
    if (!row.live) {
      const f = await api.forecast(t, row.id).catch(() => null);
      if (f) {
        const ok = await ask({
          title: `Turn on "${row.name}"?`,
          body: <>It will cost about <b>{usd(f.monthlyUsd)} a month</b> in AI: {f.runsPerMonth.toLocaleString()} runs × {usdRun(f.perRunUsd)}, going by {f.runsBasis}.
            {!f.capUsd && <label className="row small" style={{ gap: 8, marginTop: 12 }}><input id={`cap-on-${row.id}`} type="checkbox" defaultChecked /> Stop it if it reaches {usd(f.suggestedCapUsd)} this month</label>}
            {f.capUsd ? <><br />Monthly cap: {usd(f.capUsd)}.</> : null}</>,
          confirm: 'Turn on',
        });
        if (!ok) return;
        if (!f.capUsd && (document.getElementById(`cap-on-${row.id}`) as HTMLInputElement | null)?.checked) await api.setCap(t, row.id, f.suggestedCapUsd);
      }
    }
    const r = await api.setLive(t, row.id, !row.live);
    onChanged({ live: r.live, watch_error: null, paused_reason: null });
    toast(r.live ? 'Agent turned on' : 'Agent turned off');
  });
  const letItAct = () => act('trust', async () => { const r = await api.dropApproval(t, row.id); onChanged({ graph: r.graph }); setHealth((h) => h && { ...h, suggestion: undefined }); toast('Approval step removed: it now acts on its own'); });
  const remove = () => act('delete', async () => { await api.deleteWorkflow(t, row.id); toast('Agent deleted', 'info'); onDeleted(); });
  // Objects this agent writes (where a field limit makes sense).
  const written = [...new Set(row.graph.nodes.filter((n) => n.type === 'sf.updateRecord' || n.type === 'sf.createRecord').map((n) => String(n.config.sobject ?? '')).filter(Boolean))];
  const [fieldsDraft, setFieldsDraft] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(row.allowed_fields ?? {}).map(([o, f]) => [o, f.join(', ')])));
  const saveFields = () => act('fields', async () => {
    const allowed = Object.fromEntries(Object.entries(fieldsDraft).map(([o, v]) => [o, v.split(',').map((x) => x.trim()).filter((x) => /^\w+$/.test(x))]));
    const r = await api.setAllowedFields(t, row.id, allowed);
    onChanged({ allowed_fields: r.allowed });
    toast('Field limits saved');
  });
  const replay = async () => { setBt('loading'); try { setBt(await api.backtest(t, row.id)); } catch (e) { setBt({ error: (e as Error).message }); } };

  const status = row.live ? (row.watch_error ? <Status tone="bad" title={row.watch_error}>Problem</Status> : <Status tone="ok">On</Status>) : row.paused_reason ? <Status tone="bad">Paused</Status> : <Status tone="neutral">Off</Status>;
  const done = runs.filter((r) => r.status !== 'waiting');
  const rate = done.length ? Math.round((done.filter((r) => r.status === 'done').length / done.length) * 100) : null;
  const cost30 = runs.filter((r) => Date.now() - Date.parse(r.created_at) < 30 * 86_400_000).reduce((a, r) => a + Number(r.cost_usd || 0), 0);
  const runCols: Column<Run>[] = [
    { key: 'status', header: 'Status', render: (r) => <Status tone={runTone(r.status)}>{runLabel(r.status)}</Status> },
    { key: 'out', header: 'Result', render: (r) => <span className="muted clamp1">{r.output ?? '—'}</span> },
    { key: 'when', header: 'When', align: 'right', render: (r) => <span className="muted">{when(r.created_at)}</span> },
  ];

  return (
    <div className="pg">
      {confirmUi}
      <header className="ph">
        <button className="link-btn crumb-back" onClick={onBack}><ArrowLeft size={14} /> Agents</button>
        <div className="ph-row">
          <div className="ph-text">
            <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
              <h1 className="ph-title">{row.name}</h1>
              {status}
              {row.live && row.realtime && <Status tone="info">Real-time</Status>}
            </div>
            <p className="ph-desc">{triggerText(row)} · {row.graph.nodes.filter((n) => !n.type.startsWith('trigger.') && n.type !== 'util.output').length} steps</p>
          </div>
          <div className="ph-actions">
            <button onClick={onEdit}><Pencil size={15} /> Edit steps</button>
            {canRun && (
              <button className={row.live ? '' : 'primary'} onClick={() => void toggleLive()} disabled={!!busy}>
                {busy === 'live' ? <Loader2 size={15} className="spin" /> : <Power size={15} />} {row.live ? 'Turn off' : 'Turn on'}
              </button>
            )}
          </div>
        </div>
        {!row.live && row.paused_reason && (
          <div className="paused-note" role="status"><b>Paused automatically.</b> {row.paused_reason.replace(/^Paused /, 'It was paused ')} Fix the cause, then turn it on again.</div>
        )}
        <div className="ph-below">
          <div className="ptabs" role="tablist">
            {(['overview', 'runs', 'settings'] as TabId[]).map((x) => (
              <button key={x} role="tab" aria-selected={tab === x} className={tab === x ? 'on' : ''} onClick={() => setTab(x)}>
                {x === 'overview' ? 'Overview' : x === 'runs' ? `Runs${runs.length ? ` · ${runs.length}` : ''}` : 'Settings'}
              </button>
            ))}
          </div>
        </div>
      </header>
      {err && <div className="card warn">{err}</div>}

      {tab === 'overview' && <>
        {health?.suggestion && (
          <div className={`banner ${health.suggestion.kind === 'drop_approval' ? 'ok' : health.suggestion.kind === 'review' ? 'warn' : 'bad'}`}>
            <div><b>{health.suggestion.title}</b><span>{health.suggestion.detail}</span></div>
            {health.suggestion.kind === 'drop_approval'
              ? <button className="sm" onClick={() => void letItAct()} disabled={!!busy}>Let it act without asking</button>
              : <button className="sm" onClick={() => setTab('runs')}>See runs</button>}
          </div>
        )}
        <div className="agent-grid">
          <Panel title="What it does" action={<button className="link-btn" onClick={onEdit}>Edit <ChevronRight size={14} /></button>}>
            <StepsView nodes={rf.nodes} edges={rf.edges} onSelect={onEdit} readOnly />
          </Panel>
          <div className="smart-col">
            <Panel title="Last 30 days">
              <Facts items={[
                ['Runs', String(health?.runs ?? 0)],
                ['Succeeded', rate === null ? '—' : `${rate}%`],
                ['Approved', health ? `${health.approved} of ${health.approved + health.rejected}` : '—'],
                ['AI cost', money(cost30)],
              ]} />
            </Panel>
            <CostPanel tenant={tenant} workflowId={row.id} />
            <LessonsPanel tenant={tenant} row={row} />
            {canRun && (
              <Panel title="Replay last 30 days">
                <p className="muted small" style={{ margin: '0 0 12px' }}>See what it would have done last month, on a sample of real records. Nothing is written.</p>
                <button onClick={() => void replay()} disabled={bt === 'loading'}><History size={15} /> Replay</button>
              </Panel>
            )}
          </div>
        </div>
        <Panel flush title="Recent runs" action={runs.length > 5 && <button className="link-btn" onClick={() => setTab('runs')}>All runs <ChevronRight size={14} /></button>}>
          <Table columns={runCols} rows={runs.slice(0, 5)} rowKey={(r) => r.id} onRowClick={() => setTab('runs')}
            empty={<Empty title="No runs yet" body={canRun ? 'Try it on records from the editor, or turn it on.' : 'Run it from the editor to see results here.'} />} />
        </Panel>
      </>}

      {tab === 'runs' && <>
        <AgentChanges tenant={tenant} workflowId={row.id} />
        <RunsPage tenant={tenant} workflowId={row.id} embedded />
      </>}

      {tab === 'settings' && (
        <div className="smart-col" style={{ maxWidth: 720 }}>
          {isRecord && <StartMode tenant={tenant} row={row} onChanged={onChanged} />}
          {isWebhook && <WebhookPanel tenant={tenant} row={row} />}
          {isRecord && <BackfillPanel tenant={tenant} row={row} />}
          {written.length > 0 && (
            <Panel title="Fields it may change">
              <p className="muted small" style={{ margin: '0 0 12px' }}>Limit what this agent can write. Leave empty for no limit (workspace rules still apply). Field API names, separated by commas.</p>
              <div className="form">
                {written.map((o) => (
                  <div className="frow" key={o}>
                    <div className="flabel"><b>{o}</b></div>
                    <div className="ffield"><input id={`af-${o}`} value={fieldsDraft[o] ?? ''} onChange={(e) => setFieldsDraft({ ...fieldsDraft, [o]: e.target.value })} placeholder="e.g. Status, Priority" /></div>
                  </div>
                ))}
              </div>
              <div className="row" style={{ marginTop: 12 }}><button className="primary" onClick={() => void saveFields()} disabled={busy === 'fields'}>Save limits</button></div>
            </Panel>
          )}
          <VersionsPanel tenant={tenant} row={row} onRestored={onChanged} />
          <MovePanel tenant={tenant} row={row} />
          <Panel title="Delete agent">
            <div className="setting-row">
              <p className="muted small" style={{ margin: 0 }}>Removes the agent. Its past runs stay in Activity.</p>
              <ConfirmDelete onConfirm={() => void remove()} busy={busy === 'delete'} />
            </div>
          </Panel>
        </div>
      )}

      {bt && (
        <ResultModal title="Replay: the last 30 days" sub="What this agent would have done if it had been on. Nothing was written to Salesforce." onClose={() => setBt(null)}>
          {bt === 'loading' ? <Working text="Replaying on a sample of last month's records…" /> : 'error' in bt ? <div className="err">{bt.error}</div> : <BacktestView b={bt} />}
        </ResultModal>
      )}
    </div>
  );
}

/** Two-step delete inside the page (no browser dialog). */
function ConfirmDelete({ onConfirm, busy }: { onConfirm: () => void; busy: boolean }) {
  const [sure, setSure] = useState(false);
  return sure
    ? <div className="row" style={{ gap: 8 }}><button onClick={() => setSure(false)}>Cancel</button><button className="danger-solid" onClick={onConfirm} disabled={busy}>{busy ? <Loader2 size={15} className="spin" /> : <Trash2 size={15} />} Delete for good</button></div>
    : <button className="danger" onClick={() => setSure(true)}><Trash2 size={15} /> Delete</button>;
}
