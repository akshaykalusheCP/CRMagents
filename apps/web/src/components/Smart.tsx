import { AlertTriangle, CheckCircle2, Loader2, X } from 'lucide-react';
import type { ReactNode } from 'react';
import type { BacktestResult, RegressionResult } from '../api';
import { Facts, Status } from './ui';

// Result views for the replay ("what would it have done last month") and the edit check ("what changes if I save").

const money = (v: number) => (v > 0 && v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);

export function ResultModal({ title, sub, onClose, children, footer }: { title: string; sub?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-card wide smart-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="modal-head">
          <div><h3 style={{ margin: 0 }}>{title}</h3>{sub && <p className="muted small" style={{ margin: '4px 0 0' }}>{sub}</p>}</div>
          <button className="ghost icon" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="smart-body">{children}</div>
        {footer && <div className="smart-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Working({ text }: { text: string }) {
  return <div className="row muted" style={{ padding: '24px 0' }}><Loader2 size={16} className="spin" /> {text}</div>;
}

export function BacktestView({ b }: { b: BacktestResult }) {
  if (!b.total) return <p className="muted">Nothing would have triggered this agent in the last {b.days} days.</p>;
  const unit = b.kind === 'schedule' ? 'scheduled runs' : `${b.object} records`;
  return (
    <div className="smart-col">
      <div className="bt-hero">
        <div><span className="metric-label">Would have run</span><span className="bt-big">{b.total.toLocaleString()}</span><span className="muted small">times in the last {b.days} days ({unit})</span></div>
        <div><span className="metric-label">AI cost for the month</span><span className="bt-big">{money(b.estCostUsd)}</span><span className="muted small">{money(b.costPerRunUsd)} per run</span></div>
      </div>
      <div className="dsec"><h3>What it would have changed</h3>
        {b.actions.length ? (
          <ul className="change-list">{b.actions.map((a) => <li key={a.action} className="row between"><span>{a.action}</span><b>~{a.count.toLocaleString()}</b></li>)}</ul>
        ) : <p className="muted small">No changes: every sampled run was skipped by the agent's conditions.</p>}
      </div>
      <Facts items={[
        ['Sampled', `${b.sampled} runs, spread across the period`],
        ['Would change something', `${b.acted} of ${b.sampled}`],
        ['Skipped by its conditions', `${b.skipped} of ${b.sampled}`],
        ['Would fail', b.failed ? <Status tone="bad">{b.failed} of {b.sampled}</Status> : 'None'],
      ]} />
      {b.errors.length > 0 && <div className="ab-issues">{b.errors.map((e) => <div key={e}><AlertTriangle size={14} /> {e}</div>)}</div>}
      {b.examples.length > 0 && (
        <div className="dsec"><h3>Examples</h3>
          <ul className="change-list">{b.examples.map((r) => (
            <li key={r.recordId}><b style={{ fontWeight: 500 }}>{r.label}</b>
              <div className="muted small">{r.status === 'error' ? r.error : [...r.decisions.map((d) => `${d.step}: ${d.value}`), ...r.wouldDo.filter((w) => w.action !== 'Ask for approval').map((w) => w.action)].join(' · ') || r.result}</div>
            </li>
          ))}</ul>
        </div>
      )}
      <p className="muted small">Nothing was written to Salesforce. Numbers are scaled up from the sample, so treat them as estimates.</p>
    </div>
  );
}

export function RegressionView({ r }: { r: RegressionResult }) {
  if (!r.checked) return <p className="muted">No recent finished runs to compare against{r.gone ? ` (${r.gone} were on records that no longer exist)` : ''}. Save, then try it on records.</p>;
  return (
    <div className="smart-col">
      <div className="row" style={{ gap: 10 }}>
        {r.changed.length ? <Status tone="warn">{r.changed.length} of {r.checked} would change</Status> : <Status tone="ok">Same result on all {r.checked}</Status>}
        <span className="muted small">{r.costUsd ? `${money(r.costUsd)} AI` : 'No AI cost (answers reused)'}{r.gone ? ` · ${r.gone} skipped (record deleted)` : ''}</span>
      </div>
      {r.changed.length > 0 ? (
        <table className="tbl"><thead><tr><th>Record</th><th>Before</th><th>After your edit</th></tr></thead>
          <tbody>{r.changed.map((c) => <tr key={c.runId}><td>{c.label}</td><td className="muted">{c.before}</td><td>{c.after}</td></tr>)}</tbody></table>
      ) : <p className="row muted"><CheckCircle2 size={16} color="var(--ok)" /> Your edit doesn't change what the agent did on its recent runs.</p>}
    </div>
  );
}
