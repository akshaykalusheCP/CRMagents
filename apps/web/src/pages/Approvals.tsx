import { Check, Inbox, Loader2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type Run, type Tenant } from '../api';

// One inbox for everything waiting on a person, like an email inbox: read, approve or reject.
export function ApprovalsPage({ tenant, onChange }: { tenant?: Tenant; onChange: () => void }) {
  const [items, setItems] = useState<Run[]>([]);
  const [busy, setBusy] = useState<string>('');
  const [err, setErr] = useState('');
  const load = () => tenant && api.runs(tenant.id, 'waiting').then(setItems).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [tenant?.id]);

  const decide = async (id: string, approve: boolean) => {
    if (!tenant) return;
    setBusy(id);
    try { await api.decide(tenant.id, id, approve); await load(); onChange(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(''); }
  };

  return (
    <div className="page narrow">
      <div className="page-head">
        <div>
          <h2>Approvals</h2>
          <p>Agents pause here before changing anything in Salesforce. Nothing happens until you decide.</p>
        </div>
      </div>
      {err && <div className="card warn">{err}</div>}
      {items.length === 0 ? (
        <div className="empty">
          <span className="empty-icon"><Inbox size={20} /></span>
          <b style={{ color: 'var(--text)' }}>You're all caught up</b>
          <span>When an agent wants to change something, it will ask here first.</span>
        </div>
      ) : items.map((r) => {
        const step = r.steps?.find((s) => s.status === 'waiting');
        const message = String((step?.output as { message?: string } | undefined)?.message ?? 'Approve this change?');
        const [question, ...changes] = message.split('\n');
        return (
          <div key={r.id} className="card approval-card">
            <div className="row between">
              <b>{r.agent_name ?? 'Agent'}</b>
              <span className="muted small">{new Date(r.created_at).toLocaleString()}</span>
            </div>
            <div>{question}</div>
            {changes.filter(Boolean).length > 0 && <ul className="changes">{changes.filter(Boolean).map((c, i) => <li key={i}>{c.replace(/^-\s*/, '')}</li>)}</ul>}
            <div className="row">
              <button className="primary" onClick={() => decide(r.id, true)} disabled={!!busy}>{busy === r.id ? <Loader2 size={14} className="spin" /> : <Check size={14} />} Approve</button>
              <button onClick={() => decide(r.id, false)} disabled={!!busy}><X size={14} /> Reject</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
