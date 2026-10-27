import { Copy, Download, Loader2, RefreshCw, RotateCcw, Send, X, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type Lesson, type Tenant, type WorkflowRow } from '../api';
import { Panel, Status, toast, useConfirm } from './ui';

// Agent settings that aren't about its steps: how it starts, its web address, running on existing records,
// earlier versions, and moving it to another org.

const copyText = (t: string, what: string) => { void navigator.clipboard.writeText(t).then(() => toast(`${what} copied`)); };
const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

type Mode = 'realtime' | 'checks' | 'push';

/** Record agents: real-time change events, regular checks, or Salesforce pushing each record (a Flow). */
export function StartMode({ tenant, row, onChanged }: { tenant: Tenant; row: WorkflowRow; onChanged: (w: Partial<WorkflowRow>) => void }) {
  const [busy, setBusy] = useState<Mode | ''>('');
  const mode: Mode = row.sf_flow_name ? 'push' : row.realtime ? 'realtime' : 'checks';
  const set = async (to: Mode) => {
    if (to === mode) return;
    setBusy(to);
    try {
      if (mode === 'push') { await api.undeployWorkflow(tenant.id, row.id); onChanged({ sf_flow_name: null }); }
      if (to === 'push') { const r = await api.deployWorkflow(tenant.id, row.id); onChanged({ sf_flow_name: r.flowName }); toast('Salesforce now sends each record the moment it is saved'); }
      if (to === 'realtime' || to === 'checks') {
        if (!row.live) await api.setLive(tenant.id, row.id, true).then(() => onChanged({ live: true }));
        const r = await api.setRealtime(tenant.id, row.id, to === 'realtime');
        onChanged({ realtime: r.realtime });
        toast(to === 'realtime' ? 'Real-time: reacts within seconds' : 'Regular checks: every 1–5 minutes');
      }
    } catch (e) { toast((e as Error).message, 'bad'); }
    finally { setBusy(''); }
  };
  const opts: { id: Mode; title: string; body: string }[] = [
    { id: 'realtime', title: 'Real-time', body: 'Salesforce announces each change (Change Data Capture). Within seconds, no API calls. Uses one of the org\'s 5 change-event objects.' },
    { id: 'checks', title: 'Regular checks', body: 'Nimbus asks Salesforce for new records every minute when busy, every 5 when quiet. One API call per check.' },
    { id: 'push', title: 'Push from Salesforce', body: 'A small Flow tells Nimbus the moment a matching record is saved. No API calls to find changes, no change-event slots, and Salesforce keeps the notices for 3 days, so nothing is missed if Nimbus is briefly away (regular checks take over if the connection drops). Needs the Nimbus package.' },
  ];
  return (
    <Panel title="How it starts">
      <div className="mode-grid" role="radiogroup" aria-label="How it starts">
        {opts.map((o) => (
          <button key={o.id} role="radio" aria-checked={mode === o.id} className={'mode' + (mode === o.id ? ' on' : '')} onClick={() => void set(o.id)} disabled={!!busy}>
            <b>{busy === o.id ? <Loader2 size={14} className="spin" /> : o.id === 'realtime' ? <Zap size={14} /> : o.id === 'push' ? <Send size={14} /> : <RefreshCw size={14} />} {o.title}</b>
            <span>{o.body}</span>
          </button>
        ))}
      </div>
    </Panel>
  );
}

export function WebhookPanel({ tenant, row }: { tenant: Tenant; row: WorkflowRow }) {
  const [hook, setHook] = useState<{ url: string; secret: string } | null>(null);
  const [show, setShow] = useState(false);
  const [confirmUi, ask] = useConfirm();
  useEffect(() => { api.webhook(tenant.id, row.id).then(setHook).catch((e) => toast(e.message, 'bad')); }, [tenant.id, row.id]);
  const rotate = async () => {
    if (!(await ask({ title: 'Make a new secret?', body: 'The current secret stops working at once. Update every system that calls this agent.', confirm: 'New secret', danger: true }))) return;
    setHook(await api.rotateWebhook(tenant.id, row.id)); setShow(true); toast('New secret made');
  };
  if (!hook) return <Panel title="Web address"><Loader2 size={16} className="spin" /></Panel>;
  const curl = `curl -X POST '${hook.url}' \\\n  -H 'Authorization: Bearer ${show ? hook.secret : '<secret>'}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"subject": "Printer offline", "email": "ana@example.com"}'`;
  return (
    <Panel title="Web address">
      {confirmUi}
      <p className="muted small" style={{ margin: '0 0 12px' }}>Other systems start this agent by sending JSON to this address with the secret. The JSON is <code>{'{{trigger.body}}'}</code> in the steps. {row.live ? '' : 'Turn the agent on first.'}</p>
      <div className="form">
        <div className="frow"><div className="flabel"><b>Address</b></div><div className="ffield row" style={{ gap: 6 }}><input readOnly value={hook.url} /><button onClick={() => copyText(hook.url, 'Address')} aria-label="Copy address"><Copy size={14} /></button></div></div>
        <div className="frow"><div className="flabel"><b>Secret</b></div><div className="ffield row" style={{ gap: 6 }}>
          <input readOnly value={show ? hook.secret : '•'.repeat(24)} />
          <button onClick={() => setShow((x) => !x)}>{show ? 'Hide' : 'Show'}</button>
          <button onClick={() => copyText(hook.secret, 'Secret')} aria-label="Copy secret"><Copy size={14} /></button>
          <button onClick={() => void rotate()} title="Make a new secret"><RotateCcw size={14} /></button>
        </div></div>
      </div>
      <pre className="code-sample">{curl}</pre>
    </Panel>
  );
}

export function BackfillPanel({ tenant, row }: { tenant: Tenant; row: WorkflowRow }) {
  const [days, setDays] = useState(30);
  const [limit, setLimit] = useState(100);
  const [busy, setBusy] = useState(false);
  const [confirmUi, ask] = useConfirm();
  const go = async () => {
    if (!(await ask({ title: `Run on up to ${limit} existing records?`, body: <>Records {days === 1 ? 'from the last day' : `from the last ${days} days`}, newest first. They start a few a minute, and changes still wait for approval if the agent has an approval step. Try "Replay last 30 days" first to see what it would do.</>, confirm: 'Run on them' }))) return;
    setBusy(true);
    try {
      const r = await api.backfill(tenant.id, row.id, days, limit);
      toast(r.queued ? `${r.queued} records queued; they start over the next minutes` : 'No matching records');
    } catch (e) { toast((e as Error).message, 'bad'); }
    finally { setBusy(false); }
  };
  return (
    <Panel title="Run on existing records">
      {confirmUi}
      <p className="muted small" style={{ margin: '0 0 12px' }}>Turning on only reacts to new changes. To catch up on records that are already there, run it on them once.</p>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <label className="row small" style={{ gap: 6 }}>From the last <input type="number" min={1} max={3650} value={days} onChange={(e) => setDays(Math.max(1, Number(e.target.value) || 1))} style={{ width: 80 }} /> days</label>
        <label className="row small" style={{ gap: 6 }}>at most <input type="number" min={1} max={2000} value={limit} onChange={(e) => setLimit(Math.min(2000, Math.max(1, Number(e.target.value) || 1)))} style={{ width: 90 }} /> records</label>
        <button onClick={() => void go()} disabled={busy}>{busy ? <Loader2 size={14} className="spin" /> : null} Run on them</button>
      </div>
    </Panel>
  );
}

export function VersionsPanel({ tenant, row, onRestored }: { tenant: Tenant; row: WorkflowRow; onRestored: (w: Partial<WorkflowRow>) => void }) {
  const [list, setList] = useState<Awaited<ReturnType<typeof api.versions>> | null>(null);
  const [confirmUi, ask] = useConfirm();
  const load = () => api.versions(tenant.id, row.id).then(setList).catch(() => setList([]));
  useEffect(() => { void load(); }, [tenant.id, row.id]);
  const restore = async (v: { id: number; createdAt: string }) => {
    if (!(await ask({ title: 'Go back to this version?', body: `The steps from ${when(v.createdAt)} replace the current ones. The current version stays in this list.`, confirm: 'Restore' }))) return;
    const r = await api.restoreVersion(tenant.id, row.id, v.id);
    onRestored({ name: r.name, graph: r.graph });
    toast('Restored');
    void load();
  };
  return (
    <Panel title="Versions">
      {confirmUi}
      {!list ? <Loader2 size={16} className="spin" /> : !list.length ? <p className="muted small" style={{ margin: 0 }}>Every save is kept here from now on.</p> : (
        <ul className="versions">
          {list.slice(0, 15).map((v, i) => (
            <li key={v.id}>
              <span><b>{when(v.createdAt)}</b> <span className="muted small">{v.steps} steps{v.savedBy ? ` · ${v.savedBy}` : ''}</span></span>
              {i === 0 ? <span className="muted small">Current</span> : <button className="sm" onClick={() => void restore(v)}><RotateCcw size={13} /> Restore</button>}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function MovePanel({ tenant, row }: { tenant: Tenant; row: WorkflowRow }) {
  const [orgs, setOrgs] = useState<Tenant[]>([]);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState<string[] | null>(null);
  useEffect(() => { api.tenants().then((t) => { const others = t.filter((x) => x.id !== tenant.id); setOrgs(others); setTarget(others[0]?.id ?? ''); }).catch(() => {}); }, [tenant.id]);
  const download = async () => {
    const ex = await api.exportAgent(tenant.id, row.id);
    const url = URL.createObjectURL(new Blob([JSON.stringify(ex, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = `${row.name.replace(/[^\w -]+/g, '').trim() || 'agent'}.crmagents.json`; a.click();
    URL.revokeObjectURL(url);
  };
  const copy = async () => {
    setBusy(true); setMissing(null);
    try {
      const r = await api.copyAgent(tenant.id, row.id, target);
      setMissing(r.missing);
      toast(`Copied (turned off) to ${orgs.find((o) => o.id === target)?.sf_username ?? 'the other org'}`);
    } catch (e) { toast((e as Error).message, 'bad'); }
    finally { setBusy(false); }
  };
  return (
    <Panel title="Move or copy">
      <p className="muted small" style={{ margin: '0 0 12px' }}>Copy this agent to another connected org (for example from a sandbox to production). The copy starts turned off; Nimbus checks the fields it needs exist there.</p>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {orgs.length > 0 && <>
          <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Copy to org">{orgs.map((o) => <option key={o.id} value={o.id}>{o.sf_username ?? o.sf_org_id}</option>)}</select>
          <button onClick={() => void copy()} disabled={busy || !target}>{busy ? <Loader2 size={14} className="spin" /> : <Copy size={14} />} Copy to org</button>
        </>}
        <button onClick={() => void download()}><Download size={14} /> Download file</button>
      </div>
      {missing && (missing.length
        ? <div className="card warn" style={{ marginTop: 12 }}>The other org is missing: {missing.join(', ')}. Add them there, or edit the copy, before turning it on.</div>
        : <p className="muted small" style={{ marginTop: 10 }}>Everything it needs exists in the other org.</p>)}
    </Panel>
  );
}

/** Notes people left when approving or rejecting this agent's proposals: it reads the closest ones next time. */
export function LessonsPanel({ tenant, row }: { tenant: Tenant; row: WorkflowRow }) {
  const [list, setList] = useState<Lesson[] | null>(null);
  const load = () => api.lessons(tenant.id, row.id).then(setList).catch(() => setList([]));
  useEffect(() => { void load(); }, [tenant.id, row.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const remove = async (l: Lesson) => {
    try { await api.deleteLesson(tenant.id, row.id, l.id); setList((x) => (x ?? []).filter((y) => y.id !== l.id)); toast('Forgotten'); }
    catch (e) { toast((e as Error).message, 'bad'); }
  };
  return (
    <Panel title="Learned from your team">
      {!list ? <Loader2 size={16} className="spin" /> : !list.length ? (
        <p className="muted small" style={{ margin: 0 }}>When someone approves or rejects a change with a note ("billing questions go to Finance"), the agent reads it the next time it proposes something similar.</p>
      ) : (
        <ul className="lessons">
          {list.slice(0, 8).map((l) => (
            <li key={l.id}>
              <div>
                <Status tone={l.approved ? 'ok' : 'bad'}>{l.approved ? 'Approved' : 'Rejected'}</Status>
                <p className="lesson-note">"{l.note}"</p>
                <p className="muted small">{l.proposal}{l.decidedBy ? ` · ${l.decidedBy}` : ''}</p>
              </div>
              <button className="ghost icon" aria-label="Forget this lesson" title="Forget this lesson" onClick={() => void remove(l)}><X size={14} /></button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
