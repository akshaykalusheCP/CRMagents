import { Check, ChevronRight, Inbox, Loader2, Rocket, Sparkles, Wallet, Workflow as WorkflowIcon, Zap } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { api, type Draft, type Me, type Run, type Settings, type Tenant, type UsageSummary, type WorkflowRow } from '../api';

const EXAMPLES = [
  'When a new case comes in, sort it by type and create a follow-up task. Skip closed cases.',
  'Score new leads from 0 to 100 and create a call task for the hot ones',
  'List hot leads nobody has contacted yet',
];

interface Props {
  me: Me;
  tenant?: Tenant;
  go: (tab: 'insights' | 'agents' | 'approvals' | 'activity' | 'settings') => void;
  openDraft: (d: Draft) => void;
}

export function HomePage({ me, tenant, go, openDraft }: Props) {
  const [settings, setSettings] = useState<Settings>();
  const [flows, setFlows] = useState<WorkflowRow[]>([]);
  const [usage, setUsage] = useState<UsageSummary>();
  const [waiting, setWaiting] = useState<Run[]>([]);
  const [recent, setRecent] = useState<Run[]>([]);
  const [request, setRequest] = useState('');
  const [building, setBuilding] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    api.settings().then(setSettings).catch(() => {});
    api.usage().then(setUsage).catch(() => {});
    if (!tenant) return;
    api.workflows(tenant.id).then(setFlows).catch(() => {});
    api.runs(tenant.id, 'waiting').then(setWaiting).catch(() => {});
    api.runs(tenant.id).then((r) => setRecent(r.slice(0, 6))).catch(() => {});
  }, [tenant?.id]);

  const live = flows.filter((f) => f.live).length;
  const tested = recent.some((r) => r.workflow_id && r.status !== 'error');
  // Stripe-style setup checklist: visible until every step is done.
  const checklist: { label: string; done: boolean; action: () => void; cta: string }[] = [
    { label: 'Connect your Salesforce org', done: tenant?.setup_status === 'ready', action: () => go('settings'), cta: 'Connect' },
    { label: 'Add your AI key', done: !!settings?.anthropicKey?.set, action: () => go('settings'), cta: 'Add key' },
    { label: 'Build your first agent', done: flows.length > 0, action: () => document.getElementById('describe')?.focus(), cta: 'Describe it' },
    { label: 'Test it on real records', done: tested, action: () => go('agents'), cta: 'Open agents' },
    { label: 'Turn it on', done: live > 0, action: () => go('agents'), cta: 'Open agents' },
  ];
  const doneCount = checklist.filter((c) => c.done).length;

  const build = async () => {
    if (!tenant) { go('settings'); return; }
    setBuilding(true); setErr('');
    try { openDraft(await api.draftWorkflow(tenant.id, request.trim())); }
    catch (e) { setErr((e as Error).message); }
    finally { setBuilding(false); }
  };

  const hour = new Date().getHours();
  const hello = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const first = me.email.split('@')[0].split(/[._]/)[0];

  return (
    <div className="page home">
      <h1 className="hello">{hello}, {first.charAt(0).toUpperCase() + first.slice(1)}</h1>
      <p className="muted" style={{ marginTop: 4 }}>Tell CRMagents what you want done in Salesforce. It builds the agent, you check it and turn it on.</p>

      <div className="card builder-hero">
        <div className="row"><Sparkles size={18} color="var(--accent)" /><h3>What should your agent do?</h3></div>
        <textarea
          id="describe" rows={3} value={request} onChange={(e) => setRequest(e.target.value)} disabled={building}
          placeholder="e.g. When a new case comes in, sort it by type and create a follow-up task for the owner."
          onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') void build(); }}
        />
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          {EXAMPLES.map((x) => <button key={x} className="chip example" onClick={() => setRequest(x)} disabled={building}>{x.length > 64 ? `${x.slice(0, 62)}…` : x}</button>)}
        </div>
        <div className="row">
          <button className="primary" onClick={build} disabled={building || request.trim().length < 5}>
            {building ? <><Loader2 size={15} className="spin" /> Building from your org…</> : <><Sparkles size={15} /> Build my agent</>}
          </button>
          {err && <span className="err">{err}</span>}
        </div>
      </div>

      <div className="stats">
        <Stat icon={<Inbox size={18} />} label="Waiting for you" value={String(waiting.length)} hint={waiting.length ? 'Review approvals' : 'Nothing to approve'} onClick={() => go('approvals')} accent={waiting.length > 0} />
        <Stat icon={<Zap size={18} />} label="Runs, last 24 h" value={String(usage?.runs ?? 0)} hint="See activity" onClick={() => go('activity')} />
        <Stat icon={<Wallet size={18} />} label="AI spend today" value={`$${(usage?.costUsd ?? 0).toFixed(2)}`} hint={usage?.budgetUsd != null ? `of $${usage.budgetUsd.toFixed(2)} budget` : 'no budget set'} onClick={() => go('settings')} />
        <Stat icon={<Rocket size={18} />} label="Agents turned on" value={String(live)} hint={`${flows.length} agent${flows.length === 1 ? '' : 's'} built`} onClick={() => go('agents')} />
      </div>

      <div className="home-cols">
        {doneCount < checklist.length && (
          <div className="card">
            <div className="row between"><h3>Get set up</h3><span className="muted small">{doneCount} of {checklist.length} done</span></div>
            <div className="progress"><span style={{ width: `${(doneCount / checklist.length) * 100}%` }} /></div>
            {checklist.map((c) => (
              <div key={c.label} className={'check-row' + (c.done ? ' done' : '')}>
                <span className="check-dot">{c.done && <Check size={13} />}</span>
                <span className="grow">{c.label}</span>
                {!c.done && <button className="sm" onClick={c.action}>{c.cta}</button>}
              </div>
            ))}
          </div>
        )}
        <div className="card">
          <div className="row between"><h3>Recent activity</h3><button className="ghost sm" onClick={() => go('activity')}>See all <ChevronRight size={14} /></button></div>
          {recent.length === 0 && <span className="muted small">No runs yet. Build an agent and test it.</span>}
          {recent.map((r) => (
            <div key={r.id} className="activity-row">
              <span className={'dot ' + (r.status === 'done' ? 'ok' : r.status === 'error' ? 'error' : 'waiting')} />
              <WorkflowIcon size={14} className="muted" />
              <span className="grow">{r.agent_name ?? 'Run'}</span>
              <span className="muted small">{new Date(r.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Stat({ icon, label, value, hint, onClick, accent }: { icon: ReactNode; label: string; value: string; hint: string; onClick: () => void; accent?: boolean }) {
  return (
    <button className={'stat' + (accent ? ' accent' : '')} onClick={onClick}>
      <span className="stat-icon">{icon}</span>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
      <span className="stat-hint">{hint}</span>
    </button>
  );
}
