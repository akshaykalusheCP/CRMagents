import { ChevronRight, Lightbulb, Plus, Radar, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, type AgentHealth, type Me, type Run, type Settings, type Suggestion, type Tenant, type UsageSummary, type WorkflowRow } from '../api';
import { FirstRun } from '../components/FirstRun';
import { Empty, Meter, PageHeader, Panel, Status, Table, Trend, toast, type Column } from '../components/ui';

// Home is a "today" view: what ran, what it cost, and what needs a person. Building happens on the Agents page.

type Go = (tab: 'discover' | 'insights' | 'agents' | 'approvals' | 'activity' | 'settings') => void;

const DAYS = 14;
const day = (d: Date) => d.toISOString().slice(0, 10);
const short = (iso: string) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
const time = (iso: string) => {
  const d = new Date(iso);
  return day(d) === day(new Date()) ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : short(iso);
};
const money = (v: number) => (v < 0.01 && v > 0 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);

export function runTone(status: string) {
  return status === 'done' ? 'ok' : status === 'error' ? 'bad' : status === 'waiting' || status === 'stopped' ? 'warn' : status === 'sleeping' ? 'info' : 'neutral';
}
export function runLabel(status: string) {
  return ({ done: 'Succeeded', error: 'Failed', waiting: 'Waiting for approval', running: 'Running', stopped: 'Stopped: needs you', cancelled: 'Cancelled', sleeping: 'Waiting (timer)' } as Record<string, string>)[status] ?? status;
}

export function HomePage({ me, tenant, go, newAgent, openSettings }: { me: Me; tenant?: Tenant; go: Go; newAgent: (request?: string) => void; openSettings: (section: 'orgs' | 'ai', connect?: boolean) => void }) {
  const [settings, setSettings] = useState<Settings>();
  const [flows, setFlows] = useState<WorkflowRow[]>([]);
  const [usage, setUsage] = useState<UsageSummary>();
  const [runs, setRuns] = useState<Run[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [health, setHealth] = useState<AgentHealth[]>([]);
  const [busy, setBusy] = useState('');

  useEffect(() => {
    api.settings().then(setSettings).catch(() => {});
    api.usage().then(setUsage).catch(() => {});
    if (!tenant) return;
    api.workflows(tenant.id).then(setFlows).catch(() => {});
    api.runs(tenant.id).then(setRuns).catch(() => {});
    api.suggestions(tenant.id).then(setSuggestions).catch(() => {});
    api.agentHealth(tenant.id).then(setHealth).catch(() => {});
  }, [tenant?.id]);

  const dismiss = async (key: string) => {
    if (!tenant) return;
    setSuggestions((s) => s.filter((x) => x.key !== key));
    await api.dismissSuggestion(tenant.id, key).catch(() => {});
    toast('Suggestion hidden', 'info');
  };
  const dropApproval = async (workflowId: string) => {
    if (!tenant) return;
    setBusy(workflowId);
    try { await api.dropApproval(tenant.id, workflowId); setHealth((h) => h.map((x) => (x.workflowId === workflowId ? { ...x, suggestion: undefined } : x))); toast('Approval step removed: it now acts on its own'); }
    finally { setBusy(''); }
  };
  const advice = health.filter((h) => h.suggestion);
  const nameOf = (id: string) => flows.find((f) => f.id === id)?.name ?? 'Agent';

  const agentRuns = runs.filter((r) => r.workflow_id);
  const waiting = runs.filter((r) => r.status === 'waiting');
  const failed = agentRuns.filter((r) => r.status === 'error' && Date.now() - Date.parse(r.created_at) < 86_400_000);
  const broken = flows.filter((f) => (f.live && f.watch_error) || (!f.live && f.paused_reason));
  const live = flows.filter((f) => f.live).length;

  // Runs per day for the last two weeks (zero-filled so quiet days show).
  const trend = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of agentRuns) counts.set(day(new Date(r.created_at)), (counts.get(day(new Date(r.created_at))) ?? 0) + 1);
    return Array.from({ length: DAYS }, (_, i) => {
      const d = new Date(Date.now() - (DAYS - 1 - i) * 86_400_000);
      return { label: d.toLocaleDateString([], { month: 'short', day: 'numeric' }), value: counts.get(day(d)) ?? 0 };
    });
  }, [runs]);
  const total = trend.reduce((a, p) => a + p.value, 0);

  const hour = new Date().getHours();
  const hello = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const first = me.email.split('@')[0].split(/[._]/)[0];
  const name = first.charAt(0).toUpperCase() + first.slice(1);

  const cols: Column<Run>[] = [
    { key: 'agent', header: 'Agent', render: (r) => <b style={{ fontWeight: 500 }}>{r.agent_name ?? (r.workflow_id ? 'Agent run' : 'Assistant')}</b> },
    { key: 'status', header: 'Status', render: (r) => <Status tone={runTone(r.status)}>{runLabel(r.status)}</Status> },
    { key: 'cost', header: 'AI cost', align: 'right', hideSm: true, render: (r) => <span className="muted">{r.cost_usd ? money(Number(r.cost_usd)) : '—'}</span> },
    { key: 'when', header: 'When', align: 'right', render: (r) => <span className="muted">{time(r.created_at)}</span> },
  ];

  return (
    <div className="pg">
      <PageHeader
        title={`${hello}, ${name}`}
        description={tenant ? <>Working in <b style={{ color: 'var(--text)', fontWeight: 500 }}>{tenant.sf_username ?? tenant.sf_org_id}</b> · {new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</> : 'Connect a Salesforce org to get started.'}
        actions={<>{tenant && <button className="cta" onClick={() => go('discover')}><Radar size={15} /> Find what to automate</button>}<button className="primary cta" onClick={() => newAgent()}><Plus size={15} /> New agent</button></>}
      />

      <FirstRun tenant={tenant} settings={settings} agents={flows.length} tried={agentRuns.some((r) => r.status !== 'error')} live={live}
        isAdmin={me.role === 'owner' || me.role === 'admin'} openSettings={openSettings} openAgents={() => go('agents')} newAgent={newAgent} />

      {suggestions.length > 0 && (
        <section className="dsec" aria-label="Suggested agents">
          <div className="row between"><h2 className="sec-h"><Lightbulb size={16} /> Suggested for you</h2><span className="muted small">Found in your Salesforce data · no AI used</span></div>
          <div className="sugg-grid">
            {suggestions.slice(0, 3).map((s) => (
              <article key={s.key} className="sugg">
                <span className="tag">{s.object}</span>
                <h3>{s.title}</h3>
                <p>{s.finding}</p>
                <div className="sugg-actions">
                  <button className="sm" onClick={() => newAgent(s.request)}>Build this agent</button>
                  <button className="ghost sm" onClick={() => void dismiss(s.key)} aria-label={`Dismiss ${s.title}`}><X size={14} /> Dismiss</button>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      <div className="home2-top">
        <Panel>
          <div className="metric-head">
            <div>
              <div className="metric-label">Agent runs</div>
              <div className="metric-value">{total}</div>
              <div className="metric-sub">Last {DAYS} days · {short(new Date(Date.now() - (DAYS - 1) * 86_400_000).toISOString())} to today</div>
            </div>
            <button className="link-btn" onClick={() => go('activity')}>View activity <ChevronRight size={14} /></button>
          </div>
          <Trend points={trend} format={(v) => `${v} run${v === 1 ? '' : 's'}`} />
        </Panel>

        <Panel flush>
          <div className="side-metrics">
            <button className="side-metric" onClick={() => go('approvals')}>
              <div className="row1"><span className="metric-label">Waiting for approval</span>{waiting.length > 0 && <Status tone="warn">Needs you</Status>}</div>
              <span className="v">{waiting.length}</span>
            </button>
            <button className="side-metric" onClick={() => go('settings')}>
              <div className="row1"><span className="metric-label">AI spend today</span><span className="muted small">{usage?.budgetUsd != null ? `of ${money(usage.budgetUsd)}` : 'no budget'}</span></div>
              <span className="v">{money(usage?.costUsd ?? 0)}</span>
              {usage?.budgetUsd != null && <Meter value={usage.costUsd} max={usage.budgetUsd} label="AI budget used today" />}
            </button>
            <button className="side-metric" onClick={() => go('agents')}>
              <div className="row1"><span className="metric-label">Agents turned on</span><span className="muted small">of {flows.length}</span></div>
              <span className="v">{live}</span>
            </button>
          </div>
        </Panel>
      </div>

      <div className="home2-cols">
        <Panel flush title="Needs attention">
          {waiting.length + broken.length + failed.length + advice.length === 0 ? (
            <Empty title="All clear" body="Approvals, failed runs and agents with problems show up here." />
          ) : (
            <>
              {advice.map((h) => (
                <div key={'h' + h.workflowId} className="att-row">
                  <Status tone={h.suggestion!.kind === 'drop_approval' ? 'ok' : h.suggestion!.kind === 'review' ? 'warn' : 'bad'}>{h.suggestion!.kind === 'drop_approval' ? 'Earned trust' : h.suggestion!.kind === 'review' ? 'Review' : 'Fix'}</Status>
                  <div className="grow"><b>{nameOf(h.workflowId)}: {h.suggestion!.title}</b><span>{h.suggestion!.detail}</span></div>
                  {h.suggestion!.kind === 'drop_approval'
                    ? <button className="sm" disabled={busy === h.workflowId} onClick={() => void dropApproval(h.workflowId)} title="Remove the approval step so it acts on its own">Let it act</button>
                    : <button className="sm" onClick={() => go(h.suggestion!.kind === 'fix' ? 'activity' : 'agents')}>Open</button>}
                </div>
              ))}
              {waiting.slice(0, 4).map((r) => (
                <div key={r.id} className="att-row"><Status tone="warn">Approve</Status><div className="grow"><b>{r.agent_name ?? 'Agent run'}</b><span>Waiting since {time(r.created_at)}</span></div><button className="sm" onClick={() => go('approvals')}>Review</button></div>
              ))}
              {broken.map((f) => (
                <div key={f.id} className="att-row"><Status tone="bad">{f.live ? 'Problem' : 'Paused'}</Status><div className="grow"><b>{f.name}</b><span>{f.live ? f.watch_error : f.paused_reason}</span></div><button className="sm" onClick={() => go('agents')}>Open</button></div>
              ))}
              {failed.slice(0, 4).map((r) => (
                <div key={r.id} className="att-row"><Status tone="bad">Failed</Status><div className="grow"><b>{r.agent_name ?? 'Agent run'}</b><span>{time(r.created_at)}</span></div><button className="sm" onClick={() => go('activity')}>Details</button></div>
              ))}
            </>
          )}
        </Panel>

        <Panel flush title="Recent activity" action={<button className="link-btn" onClick={() => go('activity')}>See all <ChevronRight size={14} /></button>}>
          <Table columns={cols} rows={runs.slice(0, 6)} rowKey={(r) => r.id} onRowClick={() => go('activity')}
            empty={<Empty title="No runs yet" body="Runs appear here once an agent is tested or turned on." action={<button className="sm" onClick={() => newAgent()}>New agent</button>} />} />
        </Panel>
      </div>
    </div>
  );
}
