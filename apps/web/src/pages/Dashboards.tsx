import { ArrowLeft, LayoutDashboard, Loader2, MoreVertical, Plus, Trash2, X } from 'lucide-react';
import { useConfirm } from '../components/ui';
import { useEffect, useMemo, useState } from 'react';
import { api, type ChartKind, type DashRange, type DashSummary, type Tenant, type TileData, type TileSpec } from '../api';
import { BarChart } from '../components/viz/Charts';
import { ColumnChart, MultiLine, SortTable, StackedBar, labelOf, pivot } from '../components/viz/More';
import { fmt } from '../components/viz/format';

// Dashboards built from a sentence. The AI drafts tiles (real SOQL, checked against the org); the user picks the
// chart for each tile from the forms that suit its data, filters by date, drills into any bar, exports CSV.

const RANGES: { id: DashRange; label: string }[] = [
  { id: 'THIS_MONTH', label: 'This month' }, { id: 'LAST_MONTH', label: 'Last month' },
  { id: 'THIS_QUARTER', label: 'This quarter' }, { id: 'LAST_QUARTER', label: 'Last quarter' },
  { id: 'THIS_YEAR', label: 'This year' }, { id: 'LAST_YEAR', label: 'Last year' },
  { id: 'LAST_N_DAYS:30', label: 'Last 30 days' }, { id: 'LAST_N_DAYS:90', label: 'Last 90 days' },
  { id: 'LAST_N_DAYS:365', label: 'Last 12 months' }, { id: 'all', label: 'All time' },
];

const CHART_LABEL: Record<ChartKind, string> = {
  kpi: 'Number', bar: 'Bars', column: 'Columns', line: 'Line', area: 'Area', stacked: 'Stacked bars', multiline: 'Lines', table: 'Table',
};

const EXAMPLES = [
  'Sales overview: pipeline by stage, won revenue by month, top accounts, biggest open deals',
  'Service health: open cases by priority and status, cases created per month, oldest open cases',
  'Lead funnel: leads by source and status, new leads per month, conversion rate',
];

const SINGLE_CHARTS: (ChartKind | 'auto')[] = ['auto', 'kpi', 'bar', 'column', 'line', 'stacked', 'table'];

const isTime = (k: string) => /month|year|quarter|week|day|date/i.test(k);
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0) || 0);

/** Chart forms that suit a tile's data shape, so the picker never offers a chart that would mislead. */
export function chartsFor(t: TileData): ChartKind[] {
  if (!t.value_key || !t.label_key) {
    return t.rows.length === 1 && t.value_key ? ['kpi', 'table'] : ['table'];
  }
  if (t.series_key) return isTime(t.label_key) ? ['multiline', 'stacked', 'table'] : ['stacked', 'multiline', 'table'];
  const out: ChartKind[] = t.rows.length <= 1 ? ['kpi'] : [];
  out.push('bar', 'column');
  if (t.rows.length > 1 && (isTime(t.label_key) || t.rows.length >= 3)) out.push('line', 'area');
  out.push('table');
  return out;
}

/** What we'd pick: time → line, one row → number, many categories → bars, two dimensions → stacked. */
export function recommend(t: TileData): ChartKind {
  const ok = chartsFor(t);
  if (ok.includes('kpi') && t.rows.length === 1 && !t.label_key) return 'kpi';
  if (t.series_key) return ok[0];
  if (t.label_key && isTime(t.label_key) && ok.includes('line')) return 'line';
  return ok.includes('bar') ? (t.rows.length <= 6 && isTime(t.label_key) ? 'column' : 'bar') : ok[0];
}

const spec = (t: TileData): TileSpec => ({
  title: t.title, question: t.question, soql: t.soql, chart: t.chart, label_key: t.label_key, series_key: t.series_key,
  value_key: t.value_key, format: t.format, date_field: t.date_field, drill_soql: t.drill_soql, size: t.size,
});

export function DashboardsPage({ tenant }: { tenant: Tenant }) {
  const [list, setList] = useState<DashSummary[]>([]);
  const [open, setOpen] = useState<{ id?: string; name: string; description: string; prompt: string; tiles: TileData[]; dirty: boolean } | null>(null);
  const [range, setRange] = useState<DashRange>('all');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [adding, setAdding] = useState(false);
  const [drill, setDrill] = useState<{ tile: TileData; label: string; columns: string[]; rows: Record<string, unknown>[] } | null>(null);
  const [focus, setFocus] = useState<TileData | null>(null);
  const [confirmUI, ask] = useConfirm();
  const t = tenant.id;

  const refreshList = () => api.dashboards(t).then(setList).catch((e) => setErr(e.message));
  useEffect(() => {
    void refreshList(); setOpen(null);
    const id = new URLSearchParams(location.search).get('dash'); // ?dash= deep link
    if (id) void openSaved(id);
  }, [t]);

  const guard = async (label: string, fn: () => Promise<void>) => {
    setBusy(label); setErr('');
    try { await fn(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(''); }
  };

  const draft = (text: string) => guard('Designing your dashboard… this takes about 20 seconds', async () => {
    const d = await api.draftDashboard(t, text, range);
    setOpen({ name: d.name, description: d.description, prompt: text, tiles: d.tiles, dirty: true });
    setNote([`Drafted ${d.tiles.length} tiles for $${d.costUsd.toFixed(3)}. Pick a chart for each, then save.`, ...d.warnings].join(' '));
  });

  const openSaved = (id: string, r = range) => guard('Loading from Salesforce…', async () => {
    const d = await api.dashboard(t, id, r);
    setOpen({ id: d.id, name: d.name, description: d.description, prompt: d.prompt, tiles: d.tiles, dirty: false });
    setNote('');
  });

  const changeRange = (r: DashRange) => {
    setRange(r);
    if (!open) return;
    if (open.id && !open.dirty) return void openSaved(open.id, r);
    void guard('Updating…', async () => {
      const rows = await api.runTiles(t, open.tiles.map(spec), r);
      setOpen((o) => o && { ...o, tiles: rows.map((x, i) => ({ ...x, id: o.tiles[i].id })) });
    });
  };

  const save = () => open && guard('Saving…', async () => {
    const body = { name: open.name.trim() || 'Dashboard', description: open.description, tiles: open.tiles.map(spec) };
    if (open.id) await api.saveDashboard(t, open.id, body);
    const id = open.id ?? (await api.createDashboard(t, { ...body, prompt: open.prompt })).id;
    await refreshList();
    const d = await api.dashboard(t, id, range); // reload so tiles carry their saved ids
    setOpen({ id: d.id, name: d.name, description: d.description, prompt: d.prompt, tiles: d.tiles, dirty: false });
    setNote('Saved.');
  });

  const remove = async () => open?.id && await ask({ title: `Delete "${open.name}"?`, body: 'The dashboard and its tiles are removed. Your Salesforce data is not touched.', confirm: 'Delete', danger: true }) && guard('Deleting…', async () => {
    await api.deleteDashboard(t, open.id!);
    setOpen(null);
    await refreshList();
  });

  const addTile = (text: string, chart: ChartKind | 'auto') => guard('Building the tile…', async () => {
    const ask = chart === 'auto' ? text : `${text}. Show it as a ${CHART_LABEL[chart].toLowerCase()} chart (chart type "${chart}").`;
    const d = await api.draftDashboard(t, ask, range, true);
    if (!d.tiles.length) throw new Error(d.warnings[0] ?? 'Could not build that tile — try naming the object and field.');
    setOpen((o) => o && { ...o, tiles: [...o.tiles, ...d.tiles], dirty: true });
    setAdding(false);
  });

  const update = (i: number, patch: Partial<TileData>) => setOpen((o) => o && { ...o, dirty: true, tiles: o.tiles.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const move = (i: number, d: number) => setOpen((o) => {
    if (!o || i + d < 0 || i + d >= o.tiles.length) return o;
    const tiles = [...o.tiles];
    [tiles[i], tiles[i + d]] = [tiles[i + d], tiles[i]];
    return { ...o, tiles, dirty: true };
  });

  const doDrill = (tile: TileData, label: string) => guard('Loading records…', async () => {
    const r = await api.drillTile(t, spec(tile), label, range);
    setDrill({ tile, label, ...r });
  });

  const rangeSelect = (
    <select value={range} onChange={(e) => changeRange(e.target.value as DashRange)} aria-label="Date range" disabled={!!busy}>
      {RANGES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
    </select>
  );

  // ---------- List + describe ----------
  if (!open) {
    return (
      <div className="dash">
        <div className="card describe">
          <h3>Describe a dashboard</h3>
          <textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="e.g. Pipeline by stage and owner, won revenue per month this year, and my 10 biggest open deals" />
          <div className="chips">
            {EXAMPLES.map((x) => <button key={x} className="chip example" onClick={() => setPrompt(x)}>{x.split(':')[0]}</button>)}
          </div>
          <div className="row">
            <label className="row muted small" style={{ gap: 8 }}>Date range {rangeSelect}</label>
            <button className="primary cta" style={{ marginLeft: 'auto' }} disabled={prompt.trim().length < 5 || !!busy} onClick={() => void draft(prompt.trim())}>
              {busy ? <Loader2 size={15} className="spin" /> : null} Build dashboard
            </button>
          </div>
          {busy && <div className="muted small row"><Loader2 size={14} className="spin" /> {busy}</div>}
          {err && <div className="card warn">{err}</div>}
        </div>

        {list.length > 0 && <h3 style={{ margin: '24px 0 10px' }}>Your dashboards</h3>}
        <div className="dash-list">
          {list.map((d) => (
            <button key={d.id} className="card dash-item" onClick={() => void openSaved(d.id)}>
              <LayoutDashboard size={20} color="var(--accent)" />
              <span><b>{d.name}</b><span className="muted small">{d.tiles} tiles · updated {new Date(d.updated_at).toLocaleDateString()}</span>
                {d.description && <span className="muted small">{d.description}</span>}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // ---------- One dashboard ----------
  return (
    <div className="dash">
      {confirmUI}
      <div className="dash-head">
        <button className="ghost icon" onClick={async () => { if (!open.dirty || await ask({ title: 'Leave without saving?', body: 'Your changes to this dashboard will be lost.', confirm: 'Leave', danger: true })) { setOpen(null); setNote(''); } }} title="All dashboards"><ArrowLeft size={16} /></button>
        <div className="dash-title">
          <input value={open.name} onChange={(e) => setOpen({ ...open, name: e.target.value, dirty: true })} aria-label="Dashboard name" />
          {open.description && <span className="muted small">{open.description}</span>}
        </div>
        {rangeSelect}
        <button className="ghost" onClick={() => setAdding(true)} disabled={!!busy}><Plus size={15} /> Add tile</button>
        {open.id && <button className="ghost icon" onClick={() => void remove()} title="Delete dashboard"><Trash2 size={15} /></button>}
        <button className="primary" onClick={() => void save()} disabled={!!busy || (!open.dirty && !!open.id)}>{open.id ? (open.dirty ? 'Save changes' : 'Saved') : 'Save dashboard'}</button>
      </div>
      {(busy || note) && <div className="muted small row" style={{ margin: '0 0 10px' }}>{busy ? <><Loader2 size={14} className="spin" /> {busy}</> : note}</div>}
      {err && <div className="card warn">{err}</div>}

      <div className="dash-grid">
        {open.tiles.map((tile, i) => (
          <TileCard key={(tile.id ?? '') + i + tile.title} tile={tile}
            onChart={(c) => update(i, { chart: c, size: c === 'kpi' ? 'third' : c === 'table' || c === 'stacked' || c === 'multiline' ? 'full' : tile.size === 'third' ? 'half' : tile.size })}
            onSize={(s) => update(i, { size: s })}
            onMove={(d) => move(i, d)}
            onRemove={() => setOpen((o) => o && { ...o, dirty: true, tiles: o.tiles.filter((_, j) => j !== i) })}
            onDrill={tile.drill_soql ? (label) => void doDrill(tile, label) : undefined}
            onFocus={() => setFocus(tile)} />
        ))}
        {!open.tiles.length && <div className="empty">No tiles. Add one by describing it.</div>}
      </div>

      {adding && <AddTile busy={busy} onClose={() => setAdding(false)} onAdd={(x, c) => void addTile(x, c)} />}

      {focus && (
        <div className="modal" onClick={() => setFocus(null)}>
          <div className="modal-card wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h3>{focus.title}</h3><button className="ghost icon" onClick={() => setFocus(null)}><X size={16} /></button></div>
            <TileBody tile={focus} onDrill={focus.drill_soql ? (l) => { setFocus(null); void doDrill(focus, l); } : undefined} />
            <details style={{ marginTop: 14 }}><summary className="muted small">Query</summary><pre className="mono small">{focus.soql}</pre></details>
          </div>
        </div>
      )}

      {drill && (
        <div className="modal" onClick={() => setDrill(null)}>
          <div className="modal-card wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div><h3>{drill.tile.title}: {drill.label}</h3><span className="muted small">{drill.rows.length} records{drill.rows.length >= 200 ? ' (first 200)' : ''}</span></div>
              <button className="ghost icon" onClick={() => setDrill(null)}><X size={16} /></button>
            </div>
            <SortTable title={`${drill.tile.title} ${drill.label}`} columns={drill.columns} rows={drill.rows} />
          </div>
        </div>
      )}
    </div>
  );
}

function AddTile({ busy, onClose, onAdd }: { busy: string; onClose: () => void; onAdd: (text: string, chart: ChartKind | 'auto') => void }) {
  const [text, setText] = useState('');
  const [chart, setChart] = useState<ChartKind | 'auto'>('auto');
  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h3>Add a tile</h3><button className="ghost icon" onClick={onClose}><X size={16} /></button></div>
        <textarea rows={2} autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Won revenue by month this year" />
        <div className="muted small" style={{ margin: '12px 0 6px' }}>How should it look?</div>
        <div className="seg wrap" role="radiogroup" aria-label="Chart type">
          {SINGLE_CHARTS.map((c) => <button key={c} className={chart === c ? 'on' : ''} onClick={() => setChart(c)} role="radio" aria-checked={chart === c}>{c === 'auto' ? 'Let AI pick' : CHART_LABEL[c]}</button>)}
        </div>
        <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
          {busy && <span className="muted small row"><Loader2 size={14} className="spin" /> {busy}</span>}
          <button className="primary" disabled={text.trim().length < 5 || !!busy} onClick={() => onAdd(text.trim(), chart)}>Add tile</button>
        </div>
      </div>
    </div>
  );
}

function TileCard({ tile, onChart, onSize, onMove, onRemove, onDrill, onFocus }: {
  tile: TileData; onChart: (c: ChartKind) => void; onSize: (s: TileData['size']) => void; onMove: (d: number) => void;
  onRemove: () => void; onDrill?: (label: string) => void; onFocus: () => void;
}) {
  const [asTable, setAsTable] = useState(false);
  const [menu, setMenu] = useState(false);
  const options = chartsFor(tile);
  const rec = recommend(tile);
  const item = (label: string, fn: () => void, danger = false) => (
    <button role="menuitem" className={'menu-item' + (danger ? ' danger' : '')} onClick={() => { setMenu(false); fn(); }}>{label}</button>
  );
  return (
    <div className={`card dash-tile ${tile.size}`}>
      <div className="dash-tile-head">
        <div className="dash-tile-title"><h3 title={tile.question}>{tile.title}</h3>
          {onDrill && tile.chart !== 'kpi' && tile.chart !== 'table' && !asTable && <span className="muted small">Click a bar for records</span>}
        </div>
        <div className="dash-tile-tools">
          <select value={tile.chart} onChange={(e) => onChart(e.target.value as ChartKind)} aria-label="Chart type" title="Chart type">
            {options.map((c) => <option key={c} value={c}>{CHART_LABEL[c]}{c === rec ? ' ★' : ''}</option>)}
            {!options.includes(tile.chart) && <option value={tile.chart}>{CHART_LABEL[tile.chart]}</option>}
          </select>
          <div className="menu-wrap">
            <button className="ghost icon sm" onClick={() => setMenu((m) => !m)} aria-haspopup="menu" aria-expanded={menu} title="More"><MoreVertical size={16} /></button>
            {menu && (
              <>
                <div className="menu-scrim" onClick={() => setMenu(false)} />
                <div className="menu" role="menu">
                  {item(asTable ? 'Show chart' : 'Show as table', () => setAsTable((x) => !x))}
                  {item('Expand', onFocus)}
                  <div className="menu-sep" />
                  <div className="menu-label">Width</div>
                  <div className="menu-seg">
                    {(['third', 'half', 'full'] as const).map((z) => <button key={z} className={tile.size === z ? 'on' : ''} onClick={() => { setMenu(false); onSize(z); }}>{z === 'third' ? 'S' : z === 'half' ? 'M' : 'L'}</button>)}
                  </div>
                  <div className="menu-sep" />
                  {item('Move earlier', () => onMove(-1))}
                  {item('Move later', () => onMove(1))}
                  {item('Remove tile', onRemove, true)}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      {tile.error ? <div className="card warn small">This tile couldn’t load: {tile.error}</div>
        : asTable ? <SortTable title={tile.title} columns={tile.columns} rows={tile.rows} format={cellFormat(tile)} />
        : <TileBody tile={tile} onDrill={onDrill} />}
    </div>
  );
}

const MONEY = /amount|revenue|price|value|pipeline|arr|mrr|total/i;
const cellFormat = (tile: TileData) => (c: string, v: unknown) => {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'number') return String(v);
  if (c === tile.value_key) return fmt(v, tile.format, undefined, false);
  return fmt(v, tile.format === 'currency' && MONEY.test(c) ? 'currency' : 'number', undefined, false);
};

export function TileBody({ tile, onDrill }: { tile: TileData; onDrill?: (label: string) => void }) {
  const series = useMemo(() => tile.rows.map((r) => ({ label: labelOf(r, tile.label_key), value: num(r[tile.value_key]) })), [tile]);
  const pv = useMemo(() => (tile.series_key ? pivot(tile.rows, tile.label_key, tile.series_key, tile.value_key)
    : { labels: series.map((s) => s.label), series: [tile.title], values: series.map((s) => [s.value]) }), [tile, series]);
  switch (tile.chart) {
    case 'kpi': {
      const key = tile.value_key || tile.columns.find((c) => typeof tile.rows[0]?.[c] === 'number') || '';
      const v = tile.rows.length === 1 ? num(tile.rows[0][key]) : tile.rows.reduce((a, r) => a + num(r[key]), 0);
      return <div className="kpi big"><span className="kpi-value">{fmt(v, tile.format, undefined, false)}</span>{tile.question && <span className="kpi-hint">{tile.question}</span>}</div>;
    }
    case 'bar': return <BarChart data={series} format={tile.format} onPick={onDrill} />;
    case 'column': return <ColumnChart data={series} format={tile.format} onPick={onDrill} />;
    case 'line': case 'area': return <MultiLine p={pv} format={tile.format} area={tile.chart === 'area'} />;
    case 'multiline': return <MultiLine p={pv} format={tile.format} />;
    case 'stacked': return tile.series_key ? <StackedBar p={pv} format={tile.format} onPick={onDrill} /> : <BarChart data={series} format={tile.format} onPick={onDrill} />;
    default: return <SortTable title={tile.title} columns={tile.columns} rows={tile.rows} format={cellFormat(tile)} />;
  }
}

