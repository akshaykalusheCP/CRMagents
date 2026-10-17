import { ArrowRight, Loader2, RotateCcw, Undo2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type RecordChange, type Tenant, type UndoReport } from '../api';
import { Status, toast, useConfirm } from './ui';

// What an agent changed in Salesforce, record by record, with the values it replaced, and the Undo button.
// Undo puts old values back only where the agent's value is still there; a person's later edit is kept.

const show = (v: unknown) => (v === null || v === undefined || v === '' ? '(empty)' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const OP: Record<string, string> = { create: 'Created', update: 'Changed', delete: 'Deleted' };

export function summarize(r: UndoReport) {
  const parts = [r.restored && `${r.restored} record${r.restored === 1 ? '' : 's'} restored`, r.deleted && `${r.deleted} new record${r.deleted === 1 ? '' : 's'} removed`, r.recovered && `${r.recovered} brought back`].filter(Boolean);
  return parts.length ? parts.join(', ') : 'Nothing needed undoing';
}

export function ChangesList({ tenant, runId, workflowId, since, onUndone, compact }: { tenant: Tenant; runId?: string; workflowId?: string; since?: string; onUndone?: () => void; compact?: boolean }) {
  const [data, setData] = useState<{ changes: RecordChange[]; outside: { runId: string; label: string }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<UndoReport | null>(null);
  const [confirmUi, ask] = useConfirm();
  const load = () => api.changes(tenant.id, { runId, workflowId, since }).then(setData).catch(() => setData({ changes: [], outside: [] }));
  useEffect(() => { setData(null); setReport(null); void load(); }, [tenant.id, runId, workflowId, since]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return <span className="row muted small"><Loader2 size={14} className="spin" /> Loading changes…</span>;
  const open = data.changes.filter((c) => !c.undone_at);
  const link = (id: string) => `${tenant.sf_instance_url}/${id}`;

  const undo = async () => {
    const recs = new Set(open.map((c) => `${c.object}:${c.record_id}`)).size;
    const ok = await ask({
      title: `Undo ${open.length} change${open.length === 1 ? '' : 's'} on ${recs} record${recs === 1 ? '' : 's'}?`,
      body: <>Old values go back where the agent's value is still there; anything a person changed since is kept. New records go to the Recycle Bin, deleted ones come back from it.
        {data.outside.length > 0 && <><br /><br />Not undoable (already sent or run outside Salesforce records): {data.outside.map((o) => o.label).join(', ')}.</>}</>,
      confirm: 'Undo changes',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = runId ? await api.undo(tenant.id, { runId }) : await api.undo(tenant.id, { changeIds: open.map((c) => c.id) });
      setReport(r);
      toast(summarize(r), r.failed.length ? 'bad' : 'ok');
      await load();
      onUndone?.();
    } catch (e) { toast((e as Error).message, 'bad'); }
    setBusy(false);
  };

  if (!data.changes.length && !data.outside.length) return <p className="muted small" style={{ margin: 0 }}>No Salesforce records were changed{runId ? ' by this run' : ''}.</p>;
  const shown = compact ? data.changes.slice(0, 40) : data.changes;
  return (
    <div className="chg">
      {confirmUi}
      <div className="chg-head">
        <span className="muted small">{open.length ? `${open.length} change${open.length === 1 ? '' : 's'} can be undone` : 'All changes were undone'}</span>
        {open.length > 0 && <button className="sm" onClick={() => void undo()} disabled={busy}>{busy ? <Loader2 size={14} className="spin" /> : <Undo2 size={14} />} Undo {runId ? 'this run' : 'these changes'}</button>}
      </div>
      {report && (report.skipped.length > 0 || report.failed.length > 0) && (
        <ul className="chg-report">
          {report.skipped.map((s, i) => <li key={'s' + i}><Status tone="warn">Kept</Status> <a href={link(s.recordId)} target="_blank" rel="noreferrer">{s.object} {s.recordId}</a>: {s.why}</li>)}
          {report.failed.map((s, i) => <li key={'f' + i}><Status tone="bad">Failed</Status> <a href={link(s.recordId)} target="_blank" rel="noreferrer">{s.object} {s.recordId}</a>: {s.error}</li>)}
        </ul>
      )}
      <ul className="chg-list">
        {shown.map((c) => (
          <li key={c.id} className={c.undone_at ? 'undone' : ''}>
            <div className="chg-row">
              <Status tone={c.op === 'delete' ? 'bad' : c.op === 'create' ? 'ok' : 'info'}>{OP[c.op]}</Status>
              <a href={link(c.record_id)} target="_blank" rel="noreferrer">{c.object} <span className="muted">{c.record_id}</span></a>
              {!runId && c.agent_name && <span className="muted small">· {c.agent_name}</span>}
              <span className="chg-when muted small">{new Date(c.created_at).toLocaleString()}</span>
            </div>
            {c.op === 'update' && c.after && (
              <div className="chg-fields">
                {Object.keys(c.after).map((f) => (
                  <span key={f}><code>{f}</code> {c.before ? show(c.before[f]) : '?'} <ArrowRight size={11} /> {show(c.after![f])}</span>
                ))}
              </div>
            )}
            {c.undone_at ? <span className="chg-note"><RotateCcw size={12} /> {c.undo_result ?? 'Undone'}{c.undone_by ? ` by ${c.undone_by}` : ''}</span>
              : !c.undoable ? <span className="chg-note warn">The old values couldn't be read, so this can't be undone automatically</span> : null}
          </li>
        ))}
      </ul>
      {compact && data.changes.length > shown.length && <span className="muted small">and {data.changes.length - shown.length} more</span>}
      {data.outside.length > 0 && <p className="muted small" style={{ margin: 0 }}>Can't be undone (already sent or run outside Salesforce records): {data.outside.slice(0, 6).map((o) => o.label).join(', ')}{data.outside.length > 6 ? '…' : ''}</p>}
    </div>
  );
}
