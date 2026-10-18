import { Check, Loader2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type Run, type Tenant } from '../api';
import { Empty, FilterTabs, PageHeader, Panel, SkeletonRows, Status, toast } from '../components/ui';

// An inbox for everything waiting on a person: the list on the left, the change on the right.

const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
function parse(r: Run) {
  const step = r.steps?.find((s) => s.status === 'waiting');
  const message = String((step?.output as { message?: string } | undefined)?.message ?? 'Approve this change?');
  const [question, ...rest] = message.split('\n');
  return { question, changes: rest.map((c) => c.replace(/^-\s*/, '').trim()).filter(Boolean) };
}

export function ApprovalsPage({ tenant, onChange, me }: { tenant?: Tenant; onChange: () => void; me?: string }) {
  const [items, setItems] = useState<Run[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [sel, setSel] = useState<string | undefined>(() => new URLSearchParams(location.search).get('run') ?? undefined); // ?run= from a Slack or Teams message
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [scope, setScope] = useState<'mine' | 'all'>('all');
  const load = () => tenant && api.runs(tenant.id, 'waiting').then((r) => { setItems(r); setLoaded(true); setSel((s) => (r.some((x) => x.id === s) ? s : r[0]?.id)); if (me && r.some((x) => x.assigned_to === me.toLowerCase())) setScope('mine'); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [tenant?.id]);

  const decide = async (id: string, approve: boolean) => {
    if (!tenant) return;
    setBusy(id + approve);
    try { await api.decide(tenant.id, id, approve, note); setNote(''); toast(approve ? 'Approved: the agent is finishing its steps' : 'Rejected: nothing was changed', approve ? 'ok' : 'info'); await load(); onChange(); }
    catch (e) { toast((e as Error).message, 'bad'); }
    finally { setBusy(''); }
  };
  const mine = (r: Run) => !r.assigned_to || r.assigned_to === me?.toLowerCase();
  const shown = items.filter((r) => scope === 'all' || (r.assigned_to && r.assigned_to === me?.toLowerCase()));
  const cur = shown.find((r) => r.id === sel) ?? shown[0];
  const p = cur && parse(cur);

  return (
    <div className="pg">
      <PageHeader title="Approvals" description="Agents pause here before changing anything in Salesforce. Nothing happens until you decide." />
      {err && <div className="card warn">{err}</div>}
      {items.length > 0 && <FilterTabs value={scope} onChange={setScope} options={[
        { id: 'mine', label: 'Assigned to me', count: items.filter((r) => r.assigned_to === me?.toLowerCase()).length },
        { id: 'all', label: 'All', count: items.length },
      ]} />}
      <Panel flush>
        {!loaded && tenant ? <SkeletonRows rows={3} cols={2} /> : items.length === 0 ? (
          <Empty title="You're all caught up" body="When an agent wants to change something, it asks here first." />
        ) : (
          <div className="inbox">
            <div className="inbox-list" role="listbox" aria-label="Waiting for approval">
              {shown.length === 0 && <Empty title="Nothing assigned to you" body="Approvals routed to you appear here. Switch to All to see the rest." />}
              {shown.map((r) => {
                const x = parse(r);
                return (
                  <button key={r.id} role="option" aria-selected={r.id === sel} className={'inbox-item' + (r.id === sel ? ' on' : '')} onClick={() => setSel(r.id)}>
                    <span className="r1"><b>{r.agent_name ?? 'Agent'}</b><span className="t">{when(r.created_at)}</span></span>
                    <span className="p">{x.changes[0] ?? x.question}</span>
                    {r.assigned_label && r.assigned_label !== 'Anyone in the workspace' && <span className="t">For {r.assigned_label}</span>}
                  </button>
                );
              })}
            </div>
            {cur && p && (
              <div className="inbox-detail">
                <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
                  <Status tone="warn">{mine(cur) ? 'Waiting for you' : 'Waiting'}</Status>
                  <span className="muted small">{when(cur.created_at)}</span>
                  <span className="muted small">· Approver: {cur.assigned_label ?? 'Anyone in the workspace'}</span>
                  {cur.started_by && <span className="muted small">· Started by {cur.started_by}</span>}
                </div>
                <h2>{cur.agent_name ?? 'Agent'}: {p.question}</h2>
                {p.changes.length > 0 && <ul className="change-list">{p.changes.map((c, i) => <li key={i}>{c}</li>)}</ul>}
                <label className="note-field">Note (optional)
                  <textarea id="approval-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why? e.g. Wrong category: this is a billing question" />
                  <span className="muted small">Notes on rejections show up in the agent's health, so you can see why changes get turned down.</span>
                </label>
                <div className="inbox-actions">
                  <button className="primary" onClick={() => void decide(cur.id, true)} disabled={!!busy}>{busy === cur.id + 'true' ? <Loader2 size={14} className="spin" /> : <Check size={14} />} Approve</button>
                  <button onClick={() => void decide(cur.id, false)} disabled={!!busy}><X size={14} /> Reject</button>
                </div>
                <span className="muted small">Approving runs the remaining steps now. Rejecting stops the run; nothing is changed.</span>
              </div>
            )}
          </div>
        )}
      </Panel>
    </div>
  );
}
