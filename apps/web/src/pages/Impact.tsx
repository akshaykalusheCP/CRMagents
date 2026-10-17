import { Ribbon } from '../components/Ribbon';
import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type Impact, type ImpactAssumptions, type Tenant } from '../api';
import { Empty, PageHeader, Panel, SkeletonRows, Table, Trend, toast, type Column } from '../components/ui';

// Impact: what the agents did, the time that saved, what it was worth and what it cost. The minutes behind the
// estimate are shown and editable, so the number can be defended in front of a manager.

const PERIODS = [7, 30, 90] as const;
const usd = (v: number) => (v >= 1000 ? `$${Math.round(v).toLocaleString()}` : v >= 10 ? `$${v.toFixed(0)}` : v > 0 && v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);
const hrs = (h: number) => (h >= 10 ? `${Math.round(h).toLocaleString()} h` : h >= 1 ? `${h.toFixed(1)} h` : `${Math.round(h * 60)} min`);
const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`);

function Delta({ now, before, good = 'up' }: { now: number; before: number; good?: 'up' | 'down' }) {
  if (!before) return <span className="imp-delta muted">first period</span>;
  const d = (now - before) / before;
  if (Math.abs(d) < 0.005) return <span className="imp-delta muted">same as before</span>;
  const better = good === 'up' ? d > 0 : d < 0;
  return <span className={'imp-delta ' + (better ? 'up' : 'down')}>{d > 0 ? '▲' : '▼'} {Math.abs(Math.round(d * 100))}% vs previous</span>;
}

const ASSUME: { key: keyof ImpactAssumptions['minutes']; label: string }[] = [
  { key: 'change', label: 'Record created or updated, task, Flow run' },
  { key: 'aiStep', label: 'AI judgement or text (sort, extract, write, research)' },
  { key: 'replySent', label: 'Email reply sent by an agent' },
  { key: 'suggestionUsed', label: 'Suggestion a person used' },
  { key: 'answer', label: 'Question an assistant answered' },
  { key: 'chat', label: 'Website chat solved without a person' },
];

export function ImpactPage({ tenant }: { tenant?: Tenant }) {
  const [days, setDays] = useState<(typeof PERIODS)[number]>(30);
  const [data, setData] = useState<Impact | null>(null);
  const [err, setErr] = useState('');
  const [draft, setDraft] = useState<ImpactAssumptions | null>(null);
  const [saving, setSaving] = useState(false);
  const load = () => { if (tenant) api.impact(tenant.id, days).then((d) => { setData(d); setDraft(d.assumptions); setErr(''); }).catch((e) => setErr(e.message)); };
  useEffect(() => { setData(null); load(); }, [tenant?.id, days]);
  if (!tenant) return <div className="pg"><PageHeader title="Impact" /><Panel><Empty title="No org connected" body="Connect a Salesforce org to see what your agents achieve." /></Panel></div>;

  const d = data;
  const okRate = d && d.runs.total ? (d.runs.ok / Math.max(d.runs.total - d.runs.waiting, 1)) : null;
  const usedRate = d && d.suggestions.total ? d.suggestions.used / d.suggestions.total : null;
  const cols: Column<Impact['agents'][number]>[] = [
    { key: 'n', header: 'Agent', render: (a) => <div className="cell-main"><b>{a.name}</b><span className="cell-sub">{a.kind === 'agent' ? 'Automation' : 'Assistant'}</span></div> },
    { key: 'r', header: 'Runs', align: 'right', render: (a) => a.runs.toLocaleString() },
    { key: 'o', header: 'Succeeded', align: 'right', hideSm: true, render: (a) => pct(a.runs ? a.ok / a.runs : null) },
    { key: 'c', header: 'Changes', align: 'right', hideSm: true, render: (a) => a.changes.toLocaleString() },
    { key: 'h', header: 'Time saved', align: 'right', render: (a) => hrs(a.hours) },
    { key: 'v', header: 'Value', align: 'right', hideSm: true, render: (a) => usd(a.value) },
    { key: 'k', header: 'AI cost', align: 'right', render: (a) => usd(a.cost) },
  ];
  const dirty = draft && d && JSON.stringify(draft) !== JSON.stringify(d.assumptions);

  return (
    <div className="pg">
      <PageHeader
        title="Impact"
        description={`What your agents did in the last ${days} days, the time it saved and what it cost.`}
        actions={<div className="seg" role="tablist" aria-label="Period">{PERIODS.map((p) => <button key={p} role="tab" aria-selected={days === p} className={days === p ? 'on' : ''} onClick={() => setDays(p)}>{p} days</button>)}</div>}
      />
      {err && <div className="card warn">{err}</div>}
      {!d ? <Panel><SkeletonRows rows={4} cols={4} /></Panel> : <>
        <div className="imp-hero">
          <div className="imp-kpi">
            <span className="metric-label">Time saved</span>
            <b>{hrs(d.hoursSaved)}</b>
            <Delta now={d.hoursSaved} before={d.previous.hoursSaved} />
          </div>
          <div className="imp-kpi">
            <span className="metric-label">Worth</span>
            <b>{usd(d.valueUsd)}</b>
            <span className="imp-delta muted">at {usd(d.assumptions.hourlyRate)} an hour</span>
          </div>
          <div className="imp-kpi">
            <span className="metric-label">AI cost</span>
            <b>{usd(d.costUsd)}</b>
            <span className="imp-delta muted">{usd(d.cost.perRun)} per agent run</span>
          </div>
          <div className="imp-kpi accent imp-kpi-glow">
            <Ribbon className="card-ribbon" strands={110} angle={0.5} width={0.6} palette="mint" />
            <span className="metric-label">Return</span>
            <b>{d.roi == null ? '—' : `${d.roi >= 100 ? Math.round(d.roi) : d.roi.toFixed(1)}×`}</b>
            <span className="imp-delta muted">value for every $1 of AI</span>
          </div>
        </div>

        <Panel title="Time saved per day" action={<span className="kb-meta">{d.runs.total.toLocaleString()} runs in {days} days</span>}>
          {d.series.some((s) => s.hours > 0)
            ? <Trend points={d.series.map((s) => ({ label: new Date(s.date).toLocaleDateString([], { day: 'numeric', month: 'short' }), value: s.hours }))} format={(v) => hrs(v)} height={200} />
            : <p className="muted small" style={{ margin: 0 }}>Nothing yet in this period. Turn an agent on, or try one from Agents → Use cases.</p>}
        </Panel>

        <div className="imp-grid">
          <Panel title="Agent work">
            <dl className="imp-facts">
              <div><dt>Runs</dt><dd>{d.runs.total.toLocaleString()}</dd></div>
              <div><dt>Succeeded</dt><dd>{pct(okRate)}</dd></div>
              <div><dt>Changes made</dt><dd>{d.work.changes.toLocaleString()} <Delta now={d.work.changes} before={d.previous.changes} /></dd></div>
              <div><dt>AI judgements and texts</dt><dd>{d.work.aiSteps.toLocaleString()}</dd></div>
              <div><dt>Questions answered</dt><dd>{d.work.answers.toLocaleString()}</dd></div>
            </dl>
          </Panel>
          <Panel title="Customers">
            <dl className="imp-facts">
              <div><dt>Website chats</dt><dd>{d.website.conversations.toLocaleString()}</dd></div>
              <div><dt>Solved without a person</dt><dd>{pct(d.website.resolvedRate)}</dd></div>
              <div><dt>Email replies sent by agents</dt><dd>{d.work.repliesSent.toLocaleString()}</dd></div>
              <div><dt>Suggested replies sent by people</dt><dd>{d.suggestions.repliesSentByPeople.toLocaleString()} of {d.suggestions.repliesSuggested.toLocaleString()}</dd></div>
            </dl>
          </Panel>
          <Panel title="Suggestions and approvals">
            <dl className="imp-facts">
              <div><dt>Suggestions on records</dt><dd>{d.suggestions.total.toLocaleString()}</dd></div>
              <div><dt>Used by people</dt><dd>{pct(usedRate)}</dd></div>
              <div><dt>Rated not helpful</dt><dd>{d.suggestions.notHelpful.toLocaleString()}</dd></div>
              <div><dt>Changes approved / rejected</dt><dd>{d.approvals.approved} / {d.approvals.rejected}</dd></div>
              <div><dt>Typical wait for a decision</dt><dd>{d.approvals.medianMinutes == null ? '—' : d.approvals.medianMinutes < 60 ? `${d.approvals.medianMinutes} min` : hrs(d.approvals.medianMinutes / 60)}</dd></div>
            </dl>
          </Panel>
        </div>

        <Panel flush title="By agent">
          <Table columns={cols} rows={d.agents} rowKey={(a) => a.id} empty={<Empty title="No agent runs in this period" body="Runs appear here once agents and assistants start working." />} />
        </Panel>

        {draft && (
          <Panel title="How time saved is estimated" action={<span className="kb-meta">Minutes a person would spend on each</span>}>
            <div className="imp-assume">
              <div className="imp-row imp-rate"><span>Cost of an hour of your team's time</span><span className="row" style={{ gap: 4 }}>$<input type="number" min={1} value={draft.hourlyRate} onChange={(e) => setDraft({ ...draft, hourlyRate: Number(e.target.value) || 1 })} aria-label="Hourly cost" /></span></div>
              {ASSUME.map((x) => (
                <div className="imp-row" key={x.key}><span>{x.label}</span><span className="row" style={{ gap: 4 }}><input type="number" min={0} max={600} value={draft.minutes[x.key]} onChange={(e) => setDraft({ ...draft, minutes: { ...draft.minutes, [x.key]: Math.max(0, Number(e.target.value) || 0) } })} aria-label={x.label} /> min</span></div>
              ))}
            </div>
            {dirty && <div className="row" style={{ gap: 8, marginTop: 12 }}>
              <button className="primary sm" disabled={saving} onClick={async () => { setSaving(true); try { await api.saveImpactAssumptions(draft); toast('Saved'); load(); } catch (e) { toast((e as Error).message, 'bad'); } finally { setSaving(false); } }}>{saving ? <Loader2 size={13} className="spin" /> : null} Save</button>
              <button className="sm" onClick={() => setDraft(d.assumptions)}>Discard</button>
            </div>}
          </Panel>
        )}
      </>}
    </div>
  );
}
