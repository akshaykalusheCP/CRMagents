import { Loader2, RefreshCw, Wrench } from 'lucide-react';
import { Markdown } from '../components/Markdown';
import { useEffect, useMemo, useState } from 'react';
import { api, type Diagnosis, type Run, type Tenant, type UsageSummary } from '../api';
import { ChangesList } from '../components/Changes';
import { Drawer, Empty, Facts, FilterTabs, Meter, PageHeader, Panel, SkeletonRows, Status, Table, toast, type Column } from '../components/ui';
import { runLabel, runTone } from './Home';

// Every run in the org, newest first. Click a run for its timeline, output and tool calls in a side panel.

type F = 'all' | 'done' | 'error' | 'waiting' | 'stopped';
const money = (v: number) => (v > 0 && v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);
const tokens = (r: Run) => r.input_tokens + r.cache_read_tokens + r.cache_write_tokens + r.output_tokens;
const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function RunsPage({ tenant, goSettings, workflowId, embedded }: { tenant?: Tenant; goSettings?: () => void; workflowId?: string; embedded?: boolean }) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState('');
  const [usage, setUsage] = useState<UsageSummary>();
  const [filter, setFilter] = useState<F>('all');
  const [openId, setOpenId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [diag, setDiag] = useState<{ runId: string; d?: Diagnosis; err?: string; loading?: boolean; applied?: boolean }>();

  const load = () => {
    api.usage().then(setUsage).catch(() => {});
    if (tenant) api.runs(tenant.id).then((r) => { setRuns(workflowId ? r.filter((x) => x.workflow_id === workflowId) : r); setLoaded(true); }).catch((e) => setErr(e.message));
  };
  useEffect(() => { load(); }, [tenant?.id]);
  const shown = useMemo(() => runs.filter((r) => filter === 'all' || r.status === filter), [runs, filter]);
  const count = (s: F) => runs.filter((r) => s === 'all' || r.status === s).length;
  const open = runs.find((r) => r.id === openId);

  if (!tenant) return <div className="pg"><PageHeader title="Activity" /><Panel><Empty title="No org connected" body="Connect a Salesforce org to see agent runs." /></Panel></div>;

  const decide = async (id: string, approve: boolean) => {
    setBusy(true);
    try { await api.decide(tenant.id, id, approve); toast(approve ? 'Approved' : 'Rejected', approve ? 'ok' : 'info'); load(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const cancel = async (runId: string) => {
    setBusy(true);
    try { await api.cancelRun(tenant.id, runId); toast('Run cancelled', 'info'); load(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const resume = async (runId: string) => {
    setBusy(true);
    try { await api.resumeRun(tenant.id, runId); toast('Run resumed'); load(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const diagnose = async (runId: string) => {
    setDiag({ runId, loading: true });
    try { setDiag({ runId, d: await api.diagnose(tenant.id, runId) }); } catch (e) { setDiag({ runId, err: (e as Error).message }); }
  };
  const applyFix = async (workflowId: string, fix: NonNullable<Diagnosis['fix']>) => {
    setBusy(true);
    try { await api.applyFix(tenant.id, workflowId, fix.nodeId, fix.changes); setDiag((d) => d && { ...d, applied: true }); toast('Fix applied to the agent'); }
    catch (e) { setDiag((d) => d && { ...d, err: (e as Error).message }); }
    finally { setBusy(false); }
  };

  const columns: Column<Run>[] = [
    { key: 'agent', header: 'Agent', render: (r) => <div className="cell-main"><b>{r.agent_name ?? (r.workflow_id ? 'Deleted agent' : 'Assistant')}</b>{r.steps?.length ? <span className="cell-sub">{r.steps.length} steps</span> : null}</div> },
    { key: 'status', header: 'Status', render: (r) => <Status tone={runTone(r.status)}>{runLabel(r.status)}</Status> },
    { key: 'tokens', header: 'Tokens', align: 'right', hideSm: true, render: (r) => <span className="muted">{tokens(r) ? tokens(r).toLocaleString() : '—'}</span> },
    { key: 'cost', header: 'AI cost', align: 'right', render: (r) => <span className="muted">{r.cost_usd ? money(Number(r.cost_usd)) : '—'}</span> },
    { key: 'when', header: 'When', align: 'right', render: (r) => <span className="muted">{when(r.created_at)}</span> },
  ];

  return (
    <div className={embedded ? 'smart-col' : 'pg'}>
      {!embedded && <PageHeader title="Activity" description="Every agent and assistant run in this org, newest first."
        actions={<button onClick={load}><RefreshCw size={15} /> Refresh</button>} />}
      {err && <div className="card warn">{err}</div>}

      {usage && !embedded && (
        <Panel flush title="Last 24 hours" action={<span className="muted small">Whole workspace</span>}>
          <div className="ustrip">
            <div><span className="metric-label">AI spend</span><span className="v">{money(usage.costUsd)}</span>
              {usage.budgetUsd !== null ? <><Meter value={usage.costUsd} max={usage.budgetUsd} label="Budget used" /><span className="muted small">of {money(usage.budgetUsd)} daily budget</span></> : <span className="muted small">No daily budget set</span>}
            </div>
            <div><span className="metric-label">Runs</span><span className="v">{usage.runs}</span></div>
            <div><span className="metric-label">Answers reused</span><span className="v">{usage.cacheHitRate === null ? '—' : `${Math.round(usage.cacheHitRate * 100)}%`}</span><span className="muted small">Cached input, no extra cost</span></div>
            <div><span className="metric-label">Tokens</span><span className="v">{(usage.tokens.input + usage.tokens.cacheRead + usage.tokens.cacheWrite + usage.tokens.output).toLocaleString()}</span><span className="muted small">{usage.tokens.output.toLocaleString()} written by AI</span></div>
          </div>
        </Panel>
      )}

      <FilterTabs value={filter} onChange={setFilter} options={[
        { id: 'all', label: 'All', count: count('all') }, { id: 'done', label: 'Succeeded', count: count('done') },
        { id: 'error', label: 'Failed', count: count('error') }, { id: 'waiting', label: 'Waiting', count: count('waiting') },
        ...(count('stopped') ? [{ id: 'stopped' as F, label: 'Stopped', count: count('stopped') }] : []),
      ]} />
      <Panel flush>
        {!loaded ? <SkeletonRows rows={6} cols={4} /> : <Table columns={columns} rows={shown} rowKey={(r) => r.id} onRowClick={(r) => setOpenId(r.id)} selected={openId}
          empty={<Empty title={runs.length ? 'No runs match this filter' : 'No runs yet'} body={runs.length ? undefined : 'Runs show up here when an agent is tested or turned on.'} />} />}
      </Panel>

      <Drawer open={!!open} onClose={() => setOpenId(undefined)}
        title={open?.agent_name ?? 'Run'}
        sub={open && <><Status tone={runTone(open.status)}>{runLabel(open.status)}</Status><span>{when(open.created_at)}</span></>}
        footer={open && ['waiting', 'running', 'stopped', 'sleeping'].includes(open.status) ? <>
          <button className="danger" onClick={() => void cancel(open.id)} disabled={busy}>Cancel run</button>
          <span style={{ flex: 1 }} />
          {open.status === 'waiting' && <><button onClick={() => void decide(open.id, false)} disabled={busy}>Reject</button>
            <button className="primary" onClick={() => void decide(open.id, true)} disabled={busy}>Approve</button></>}
          {open.status === 'stopped' && <button className="primary" onClick={() => void resume(open.id)} disabled={busy}>Resume</button>}
        </> : undefined}>
        {open && <>
          <Facts items={[
            ['AI cost', open.cost_usd ? money(Number(open.cost_usd)) : 'None'],
            ['Tokens', tokens(open) ? tokens(open).toLocaleString() : 'None'],
            ['Reused from cache', open.cache_read_tokens ? open.cache_read_tokens.toLocaleString() : 'None'],
            ['Steps', String(open.steps?.length ?? 0)],
          ]} />
          {open.status === 'sleeping' && <div className="banner ok"><div><b>Waiting on a timer</b><span>{open.steps?.find((x) => x.status === 'waiting')?.output ? String((open.steps.find((x) => x.status === 'waiting')!.output as { message?: string }).message ?? '') : 'It continues by itself.'}</span></div></div>}
          {open.status === 'stopped' && <div className="banner warn"><div><b>This run stopped part-way</b><span>{open.output}</span></div></div>}
          {open.decided_by && (
            <div className="dsec"><h3>Decision</h3>
              <p style={{ margin: 0 }}>{open.steps?.some((s) => s.type === 'logic.approval' && (s.output as { approved?: boolean } | undefined)?.approved === false) ? 'Rejected' : 'Approved'} by <b>{open.decided_by}</b>{open.decided_at ? ` · ${when(open.decided_at)}` : ''}</p>
              {open.decision_note && <p className="muted small" style={{ margin: 0 }}>“{open.decision_note}”</p>}
            </div>
          )}
          {open.purged_at && <p className="muted small" style={{ margin: 0 }}>Details were cleared under your workspace's retention setting.</p>}
          {open.status === 'error' && (
            <div className="dsec diag">
              <h3>Why it failed</h3>
              {diag?.runId !== open.id ? (
                <button onClick={() => void diagnose(open.id)}><Wrench size={14} /> Explain and suggest a fix</button>
              ) : diag.loading ? <span className="row muted small"><Loader2 size={14} className="spin" /> Reading the error…</span>
                : diag.err ? <div className="err">{diag.err}</div>
                : diag.d && (
                  <div className="diag-box">
                    <p>{diag.d.explanation}</p>
                    {diag.d.fix ? (
                      <div className="diag-fix">
                        <b>Suggested fix · {diag.d.fix.label}</b>
                        <span>{diag.d.fix.summary}</span>
                        <ul>{Object.entries(diag.d.fix.changes).map(([k, v]) => <li key={k}><code>{k}</code> → {v}</li>)}</ul>
                        {diag.applied ? <span className="status ok"><i />Applied. The next run uses it.</span>
                          : <button className="primary sm" disabled={!open.workflow_id || busy} onClick={() => void applyFix(open.workflow_id!, diag.d!.fix!)}>Apply fix to the agent</button>}
                      </div>
                    ) : diag.d.action === 'reconnect' || diag.d.action === 'settings'
                      ? <button className="sm" onClick={goSettings}>Open Settings</button>
                      : <span className="muted small">No automatic fix: this needs a change in the data or the org.</span>}
                    {diag.d.costUsd > 0 && <span className="muted small">{money(diag.d.costUsd)} AI</span>}
                  </div>
                )}
            </div>
          )}
          {tenant && ['done', 'error', 'stopped', 'cancelled'].includes(open.status) && (
            <div className="dsec"><h3>Changes in Salesforce</h3><ChangesList tenant={tenant} runId={open.id} compact /></div>
          )}
          {open.output && <div className="dsec"><h3>Result</h3><Markdown className="output-md" text={open.output} /></div>}
          {open.steps?.length > 0 && (
            <div className="dsec"><h3>Steps</h3>
              <ol className="tl2">
                {open.steps.map((s, i) => (
                  <li key={i}>
                    <span className={'tdot ' + s.status} />
                    <span className="tl-main"><span>{s.label}{s.iteration !== undefined ? ` · record ${s.iteration + 1}` : ''}{s.reused ? ' · reused' : ''}</span>{s.error && <span className="tl-err">{s.error}</span>}</span>
                    <span className="tl-ms">{s.ai ? `${s.ai.tokens.toLocaleString()} tok · ${money(s.ai.costUsd)}` : s.reused ? 'reused' : `${s.ms} ms`}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {open.trace?.length > 0 && (
            <div className="dsec"><h3>Salesforce calls by the AI</h3>
              <ol className="tl2">{open.trace.map((t, i) => <li key={i}><span className={'tdot ' + (t.ok ? 'ok' : 'error')} /><span className="tl-main"><span>{t.tool}</span>{t.error && <span className="tl-err">{t.error}</span>}</span><span /></li>)}</ol>
            </div>
          )}
        </>}
      </Drawer>
    </div>
  );
}
