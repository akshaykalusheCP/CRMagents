import { AlertTriangle, ArrowDownRight, ArrowUpRight, Bot, CheckCircle2, Eye, Loader2, Minus, Pin, PinOff, RefreshCw, Search, X } from 'lucide-react';
import { MicButton } from '../components/Voice';
import { useEffect, useState } from 'react';
import { api, type Answer, type Briefing, type Insights, type Kpi, type Tenant, type Tile, type VizFormat } from '../api';
import { BarChart, ChartCard, DataTable, LineChart } from '../components/viz/Charts';
import { fmt } from '../components/viz/format';
import { DashboardsPage } from './Dashboards';
import { PageHeader } from '../components/ui';

const PERIODS = [7, 30, 90];
const QUESTIONS = [
  'Which accounts have the most open pipeline?',
  'How many cases did we close each month this year?',
  'Who owns the most open opportunities?',
  'Leads by status',
];

/** Change versus the previous period: arrow + words, colour only reinforces (never the only signal). */
function Delta({ k, currency, period }: { k: Kpi; currency: string; period: number }) {
  if (k.previous === undefined) return k.hint ? <span className="kpi-hint">{k.hint}</span> : null;
  const diff = k.value - k.previous;
  if (Math.abs(diff) < 1e-9) return <span className="kpi-delta flat" title={`Same as the previous ${period} days`}><Minus size={14} /> No change</span>;
  const up = diff > 0;
  const good = (up && k.goodWhen === 'up') || (!up && k.goodWhen === 'down');
  const pct = k.previous ? `${Math.abs(Math.round((diff / Math.abs(k.previous)) * 100))}%` : fmt(Math.abs(diff), k.format, currency);
  return (
    <span className={'kpi-delta ' + (good ? 'good' : 'bad')} title={`${up ? 'Up' : 'Down'} ${pct} vs the previous ${period} days`}>
      {up ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />} {up ? 'Up' : 'Down'} {pct}
    </span>
  );
}

function KpiTile({ k, currency, period }: { k: Kpi; currency: string; period: number }) {
  return (
    <div className="kpi">
      <span className="kpi-label" title={k.label}>{k.label.replace(/,?\s*last \d+ days$/i, '')}</span>
      <span className="kpi-value" title={fmt(k.value, k.format, currency, false)}>{fmt(k.value, k.format, currency)}</span>
      <Delta k={k} currency={currency} period={period} />
      {k.previous !== undefined && k.hint && <span className="kpi-hint">{k.hint}</span>}
    </div>
  );
}

const cell = (v: unknown, currency: string) => (typeof v === 'number' ? fmt(v, Math.abs(v) >= 1000 ? 'currency' : 'number', currency, false) : String(v ?? ''));

/** Shows an answer (fresh or pinned) as a number, a chart or a table, always with a table option. */
function AnswerView({ a, currency }: { a: Answer; currency: string }) {
  const valueFormat: VizFormat = /amount|revenue|pipeline|sum|total_(amount|value)|value/i.test(a.valueKey) ? 'currency' : 'number';
  const table = <DataTable columns={a.columns} rows={a.rows.map((r) => a.columns.map((c) => cell(r[c], currency)))} />;
  if (a.chart === 'number') {
    const v = Number(a.rows[0]?.[a.valueKey] ?? a.rows[0]?.[a.columns[0]] ?? 0);
    return <div className="kpi big"><span className="kpi-value">{fmt(v, valueFormat, currency, false)}</span></div>;
  }
  if (a.chart === 'table' || !a.valueKey) return table;
  const data = a.rows.map((r) => ({ label: String(r[a.labelKey] ?? '(none)'), value: Number(r[a.valueKey] ?? 0) }));
  return a.chart === 'line' ? <LineChart data={data} format={valueFormat} currency={currency} /> : <BarChart data={data} format={valueFormat} currency={currency} />;
}

export function InsightsPage({ tenant, goSettings, onAutomate, fixedView, ask }: { tenant?: Tenant; goSettings: () => void; onAutomate: (request: string) => void; fixedView?: 'overview' | 'dashboards'; ask?: { q: string; n: number } }) {
  const [period, setPeriod] = useState(30);
  const [ins, setIns] = useState<Insights>();
  const [loading, setLoading] = useState(false);
  const [brief, setBrief] = useState<Briefing>();
  const [briefing, setBriefing] = useState(false);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<Answer>();
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [showSoql, setShowSoql] = useState(false);
  const [err, setErr] = useState('');
  const [view] = useState<'overview' | 'dashboards'>(() => fixedView ?? (new URLSearchParams(location.search).get('view') === 'dashboards' ? 'dashboards' : 'overview'));
  const [sec, setSec] = useState(() => new URLSearchParams(location.search).get('sec') ?? '');

  const load = async (refresh = false) => {
    if (!tenant) return;
    setLoading(true); setErr('');
    try {
      const data = await api.insights(tenant.id, period, refresh);
      setIns(data);
      // The briefing reads only these numbers; identical numbers reuse the earlier briefing at no cost.
      setBriefing(true);
      api.briefing(tenant.id, period).then(setBrief).catch((e) => setErr(e.message)).finally(() => setBriefing(false));
    } catch (e) { setErr((e as Error).message); }
    finally { setLoading(false); }
  };
  useEffect(() => { setBrief(undefined); void load(); }, [tenant?.id, period]);
  useEffect(() => { if (tenant) api.tiles(tenant.id).then(setTiles).catch(() => {}); }, [tenant?.id]);

  const doAsk = async (q = question) => {
    if (!tenant || q.trim().length < 5) return;
    setAsking(true); setErr(''); setAnswer(undefined); setShowSoql(false);
    try { setAnswer(await api.ask(tenant.id, q.trim())); }
    catch (e) { setErr((e as Error).message); }
    finally { setAsking(false); }
  };
  // A question asked by voice from the top bar.
  useEffect(() => { if (ask?.q && tenant) { setQuestion(ask.q); void doAsk(ask.q); } }, [ask?.n, tenant?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const pin = async () => {
    if (!tenant || !answer) return;
    await api.pinTile(tenant.id, answer);
    setTiles(await api.tiles(tenant.id));
    setAnswer(undefined); setQuestion('');
  };
  const unpin = async (id: string) => {
    if (!tenant) return;
    await api.unpinTile(tenant.id, id);
    setTiles((t) => t.filter((x) => x.id !== id));
  };

  if (!tenant) {
    return <div className="page"><div className="empty"><b style={{ color: 'var(--text)' }}>Connect Salesforce to see your business at a glance</b><button className="primary" onClick={goSettings}>Connect Salesforce</button></div></div>;
  }
  const cur = ins?.currency ?? 'USD';
  const current = ins?.sections.find((x) => x.id === sec) ?? ins?.sections[0];
  const TONE = { good: <CheckCircle2 size={16} color="var(--ok)" />, watch: <Eye size={16} color="var(--warn)" />, bad: <AlertTriangle size={16} color="var(--danger)" /> };
  const TONE_LABEL = { good: 'Going well', watch: 'Keep an eye on', bad: 'Needs attention' };

  const updated = ins ? new Date(ins.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

  return (
    <div className="pg insights">
      <PageHeader
        title={view === 'dashboards' ? 'Dashboards' : 'Insights'}
        description={view === 'dashboards' ? 'Describe a dashboard in a sentence. Every query is checked against your org, and you choose the charts.' : 'Your Salesforce numbers, explained in plain English.'}
        actions={view === 'overview' ? (
          <>
            <div className="seg" role="radiogroup" aria-label="Period">
              {PERIODS.map((p) => <button key={p} role="radio" aria-checked={period === p} className={period === p ? 'on' : ''} onClick={() => setPeriod(p)}>{p} days</button>)}
            </div>
            <button onClick={() => void load(true)} disabled={loading} title={updated ? `Updated ${updated}` : undefined}>
              {loading ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />} Refresh
            </button>
          </>
        ) : undefined}
      />
      {view === 'dashboards' ? <DashboardsPage tenant={tenant} /> : <>
      {err && <div className="card warn">{err}</div>}

      {/* AI briefing */}
      <div className="card briefing">
        <div className="row"><h3>Your business briefing</h3>
          {brief && <span className="muted small" style={{ marginLeft: 'auto' }}>{brief.reused ? 'Up to date' : `$${brief.costUsd.toFixed(3)}`}</span>}
        </div>
        {!brief ? (
          briefing || loading ? (
            // Same shape as the briefing, so nothing below jumps when it arrives.
            <div className="brief-skel" aria-label="Reading your numbers">
              <span className="skel skel-line" style={{ width: '62%', height: 18 }} />
              <div className="brief-cols">
                <div>{[90, 75, 82].map((w, i) => <span key={i} className="skel skel-line" style={{ width: `${w}%` }} />)}</div>
                <div>{[70, 85, 60].map((w, i) => <span key={i} className="skel skel-line" style={{ width: `${w}%` }} />)}</div>
              </div>
            </div>
          ) : <div className="muted row">No briefing yet.</div>
        ) : (
          <>
            <p className="headline">{brief.headline}</p>
            <div className="brief-cols">
              <div>
                <div className="brief-label">What we see</div>
                <ul className="brief-list">
                  {brief.highlights.map((h, i) => (
                    <li key={i}>
                      <span className="brief-icon" title={TONE_LABEL[h.tone]} aria-label={TONE_LABEL[h.tone]}>{TONE[h.tone]}</span>
                      <span><b>{h.title}</b><span className="muted">{h.detail}</span></span>
                    </li>
                  ))}
                </ul>
              </div>
              {brief.actions.length > 0 && (
                <div>
                  <div className="brief-label">Do this week</div>
                  <ul className="brief-list">
                    {brief.actions.map((a, i) => (
                      <li key={i}>
                        <span className="brief-num">{i + 1}</span>
                        <span><b>{a.title}</b><span className="muted">{a.detail}</span></span>
                        <button className="ghost sm" onClick={() => onAutomate(`${a.title}. ${a.detail}`)} title="Build an agent that does this" aria-label="Automate"><Bot size={13} /><span className="hide-sm"> Automate</span></button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Ask in plain English */}
      <div className="card ask">
        <div className="search ask-box">
          <Search size={16} />
          <input
            placeholder="Ask about your business, e.g. Which accounts have the most open pipeline?"
            value={question} onChange={(e) => setQuestion(e.target.value)} disabled={asking}
            onKeyDown={(e) => { if (e.key === 'Enter') void doAsk(); }}
          />
          <MicButton value={question} onChange={setQuestion} onDone={(v) => void doAsk(v)} label="Ask by voice" />
          <button className="primary" onClick={() => void doAsk()} disabled={asking || question.trim().length < 5}>
            {asking ? <Loader2 size={14} className="spin" /> : 'Ask'}
          </button>
        </div>
        {!answer && !asking && (
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            {QUESTIONS.map((q) => <button key={q} className="chip example" onClick={() => { setQuestion(q); void doAsk(q); }}>{q}</button>)}
          </div>
        )}
        {answer && (
          <div className="answer">
            <div className="row between">
              <div><h3>{answer.title}</h3><span className="muted small">{answer.explanation}</span></div>
              <div className="row">
                <button className="ghost sm" onClick={() => setShowSoql((s) => !s)}>{showSoql ? 'Hide query' : 'Show query'}</button>
                <button className="sm" onClick={pin}><Pin size={13} /> Pin to dashboard</button>
                <button className="ghost icon sm" onClick={() => setAnswer(undefined)} aria-label="Close"><X size={14} /></button>
              </div>
            </div>
            {showSoql && <pre className="out">{answer.soql}</pre>}
            <AnswerView a={answer} currency={cur} />
          </div>
        )}
      </div>

      {/* Pinned questions: re-run on every visit, no AI cost */}
      {tiles.length > 0 && (
        <>
          <h3 className="section-title">Pinned</h3>
          <div className="chart-grid">
            {tiles.map((t) => {
              const a: Answer = { ...t, labelKey: t.label_key, valueKey: t.value_key };
              return (
                <ChartCard key={t.id} title={t.title} sub={t.question}
                  table={<DataTable columns={t.columns} rows={t.rows.map((r) => t.columns.map((c) => cell(r[c], cur)))} />}>
                  {t.error ? <div className="err">{t.error}</div> : <AnswerView a={a} currency={cur} />}
                  <button className="ghost sm unpin" onClick={() => void unpin(t.id)}><PinOff size={13} /> Unpin</button>
                </ChartCard>
              );
            })}
          </div>
        </>
      )}

      {/* Standard business sections, computed by code: one at a time */}
      {current && (
        <section className="ins-section">
          <div className="sec-tabs" role="tablist" aria-label="Section">
            {ins!.sections.map((x) => (
              <button key={x.id} role="tab" aria-selected={x.id === current.id} className={x.id === current.id ? 'on' : ''} onClick={() => setSec(x.id)}>{x.title.replace(/\s*\(.*\)$/, '')}</button>
            ))}
          </div>
          {current.kpis.length > 0 && (
            <div className="kpi-strip">{current.kpis.map((k) => <KpiTile key={k.id} k={k} currency={cur} period={ins!.periodDays} />)}</div>
          )}
          {(() => {
            const charts = current.charts.filter((c) => c.data.some((d) => d.value !== 0));
            const lists = current.lists.filter((l) => l.rows.length > 0);
            const empty = [...current.charts.filter((c) => !charts.includes(c)), ...current.lists.filter((l) => !lists.includes(l))].map((x) => x.title);
            return (
              <>
                {(charts.length > 0 || lists.length > 0) && (
                  <div className="chart-grid">
                    {charts.map((c, i) => (
                      <ChartCard key={c.id} title={c.title} wide={charts.length % 2 === 1 && i === charts.length - 1 && lists.every((l) => l.columns.length > 4)}
                        table={<DataTable columns={[c.kind === 'line' ? 'Month' : 'Category', 'Value']} rows={c.data.map((d) => [d.label, fmt(d.value, c.format, cur, false)])} />}>
                        {c.kind === 'line' ? <LineChart data={c.data} format={c.format} currency={cur} /> : <BarChart data={c.data} format={c.format} currency={cur} />}
                      </ChartCard>
                    ))}
                    {lists.map((l) => (
                      <div key={l.id} className={'card chart-card' + (l.columns.length > 4 || lists.length % 2 === 1 ? ' wide' : '')}>
                        <div className="row between">
                          <div><h3>{l.title}</h3>{l.note && <span className="muted small">{l.note}</span>}</div>
                          {l.fix && <button className="sm" onClick={() => onAutomate(l.fix!)} title="Build an agent that handles this automatically"><Bot size={13} /> Fix with an agent</button>}
                        </div>
                        <DataTable columns={l.columns} rows={l.rows.map((r) => r.map((v, j) => (l.columns[j] === 'Why' ? <span className="why">{String(v)}</span> : l.columns[j] === 'Risk' ? <span className="badge err">{String(v)}</span> : cell(v, cur))))} />
                      </div>
                    ))}
                  </div>
                )}
                {empty.length > 0 && <p className="muted small ins-empty">Nothing in the last {ins!.periodDays} days for: {empty.join(' · ')}</p>}
              </>
            );
          })()}
        </section>
      )}
      </>}
    </div>
  );
}
