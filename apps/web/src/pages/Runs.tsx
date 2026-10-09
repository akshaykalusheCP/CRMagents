import { useEffect, useState } from 'react';
import { api, type Run, type Tenant, type UsageSummary } from '../api';

export function RunsPage({ tenant }: { tenant?: Tenant }) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [err, setErr] = useState('');
  const [usage, setUsage] = useState<UsageSummary>();
  const load = () => {
    api.usage().then(setUsage).catch(() => {});
    return tenant && api.runs(tenant.id).then(setRuns).catch((e) => setErr(e.message));
  };
  useEffect(() => { load(); }, [tenant?.id]);
  if (!tenant) return <div className="page muted">Connect an org to see runs.</div>;

  const decide = async (id: string, approve: boolean) => {
    try { await api.decide(tenant.id, id, approve); } catch (e) { setErr((e as Error).message); }
    load();
  };

  return (
    <div className="page">
      <div className="row between"><h2>Activity</h2><button onClick={load}>Refresh</button></div>
      {err && <div className="card warn">{err}</div>}
      {usage && (
        <div className="card">
          <b>AI usage, last 24 hours (whole workspace)</b>
          <div className="row" style={{ flexWrap: 'wrap', gap: 16 }}>
            <span>${usage.costUsd.toFixed(3)}{usage.budgetUsd !== null ? ` of $${usage.budgetUsd.toFixed(2)} budget` : ' (no budget)'}</span>
            <span className="muted">{usage.runs} runs</span>
            <span className="muted">cache hit {usage.cacheHitRate === null ? '–' : `${Math.round(usage.cacheHitRate * 100)}%`}</span>
            <span className="muted small">
              tokens: {usage.tokens.input.toLocaleString()} input · {usage.tokens.cacheRead.toLocaleString()} cached · {usage.tokens.cacheWrite.toLocaleString()} cache-write · {usage.tokens.output.toLocaleString()} output
            </span>
          </div>
        </div>
      )}
      {runs.map((r) => (
        <details className="card" key={r.id} open={r.status === 'waiting'}>
          <summary>
            <span className={'badge ' + (r.status === 'done' ? 'ok' : r.status === 'error' ? 'warn' : '')}>{r.status}</span>{' '}
            <b>{r.agent_name ?? 'deleted'}</b>{' '}
            <span className="muted small">{new Date(r.created_at).toLocaleString()} · {(r.input_tokens + r.cache_read_tokens + r.cache_write_tokens + r.output_tokens).toLocaleString()} tokens{r.cache_read_tokens ? ` (${r.cache_read_tokens.toLocaleString()} cached)` : ''} · ${(r.cost_usd ?? 0).toFixed(4)}</span>
          </summary>
          {r.status === 'waiting' && (
            <div className="row">
              <span>Waiting for approval:</span>
              <button className="primary" onClick={() => decide(r.id, true)}>Approve</button>
              <button onClick={() => decide(r.id, false)}>Reject</button>
            </div>
          )}
          {r.output && <pre className="out">{r.output}</pre>}
          {r.steps?.length > 0 && (
            <div className="small">
              {r.steps.map((s, i) => (
                <div key={i}><span className={'dot ' + s.status} /> {s.label}{s.iteration !== undefined ? ` #${s.iteration + 1}` : ''} <span className="muted">{s.ms}ms{s.error ? ' · ' + s.error : ''}</span></div>
              ))}
            </div>
          )}
          {r.trace?.length > 0 && <div className="small muted">Tool calls: {r.trace.map((t, i) => <div key={i}>{t.ok ? '✓' : '✗'} {t.tool} {t.error ?? ''}</div>)}</div>}
        </details>
      ))}
      {runs.length === 0 && <p className="muted">No runs yet.</p>}
    </div>
  );
}
