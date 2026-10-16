import { useMemo, useState } from 'react';
import type { VizFormat } from '../../api';
import { fmt } from './format';

// More chart forms for dashboards, same method as Charts.tsx: categorical slots in fixed order (never cycled),
// legend for 2+ series plus direct labels, 2px surface gaps between stacked segments, a tooltip on every mark.

export const MAX_SERIES = 6; // past this, smaller series fold into "Other"

export interface Pivot { labels: string[]; series: string[]; values: number[][] } // values[label][series]

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Readable label: month numbers from CALENDAR_MONTH become "Mar 2026" when a year column is present. */
export function labelOf(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  if (typeof v === 'number' && v >= 1 && v <= 12 && /month|mon|^m$/i.test(key)) {
    const yk = Object.keys(row).find((k) => /year|yr|^y$/i.test(k));
    return `${MONTHS[v - 1]}${yk ? ` ${row[yk]}` : ''}`;
  }
  return v === undefined || v === null || v === '' ? '(none)' : String(v);
}

export function pivot(rows: Record<string, unknown>[], labelKey: string, seriesKey: string, valueKey: string): Pivot {
  const labels: string[] = [];
  const totals = new Map<string, number>();
  for (const r of rows) {
    const l = labelOf(r, labelKey);
    if (!labels.includes(l)) labels.push(l);
    const s = labelOf(r, seriesKey);
    totals.set(s, (totals.get(s) ?? 0) + Number(r[valueKey] ?? 0));
  }
  // Keep the biggest series; fold the rest into "Other" so colours never cycle.
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const keep = ranked.length > MAX_SERIES ? ranked.slice(0, MAX_SERIES - 1) : ranked;
  const series = ranked.length > MAX_SERIES ? [...keep, 'Other'] : keep;
  const values = labels.map(() => series.map(() => 0));
  for (const r of rows) {
    const li = labels.indexOf(labelOf(r, labelKey));
    const s = labelOf(r, seriesKey);
    const si = series.indexOf(keep.includes(s) ? s : 'Other');
    if (si >= 0) values[li][si] += Number(r[valueKey] ?? 0);
  }
  return { labels, series, values };
}

const color = (i: number) => `var(--c${(i % 8) + 1})`;

export function Legend({ series }: { series: string[] }) {
  return (
    <div className="legend">
      {series.map((s, i) => <span key={s} className="legend-item"><i style={{ background: color(i) }} />{s}</span>)}
    </div>
  );
}

/** Horizontal stacked bars: part-to-whole across two dimensions (instead of pie charts). */
export function StackedBar({ p, format, currency, onPick }: { p: Pivot; format: VizFormat; currency?: string; onPick?: (label: string) => void }) {
  const [hover, setHover] = useState<string | null>(null);
  const totals = p.values.map((row) => row.reduce((a, b) => a + b, 0));
  const max = Math.max(...totals, 0) || 1;
  if (!p.labels.length) return <div className="viz-empty">No data for this period.</div>;
  return (
    <div>
      <Legend series={p.series} />
      <div className="bars">
        {p.labels.map((l, li) => (
          <div key={l} className={'bar-row' + (onPick ? ' clickable' : '')} onClick={() => onPick?.(l)}>
            <span className="bar-label" title={l}>{l}</span>
            <span className="bar-track stacked" style={{ width: `${(totals[li] / max) * 100}%` }}>
              {p.series.map((s, si) => p.values[li][si] > 0 && (
                <span key={s} className="seg" style={{ flexGrow: p.values[li][si], background: color(si) }}
                  onMouseEnter={() => setHover(`${l}|${s}`)} onMouseLeave={() => setHover(null)}>
                  {hover === `${l}|${s}` && <span className="viz-tip" role="tooltip"><b>{l} · {s}</b><br />{fmt(p.values[li][si], format, currency, false)}</span>}
                </span>
              ))}
            </span>
            <span className="bar-value">{fmt(totals[li], format, currency)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Vertical columns: time buckets or a few categories. */
export function ColumnChart({ data, format, currency, onPick }: { data: { label: string; value: number }[]; format: VizFormat; currency?: string; onPick?: (label: string) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!data.length) return <div className="viz-empty">No data for this period.</div>;
  const max = Math.max(...data.map((d) => d.value), 0) || 1;
  return (
    <div className="columns" onMouseLeave={() => setHover(null)}>
      {data.map((d, i) => (
        <div key={d.label + i} className={'col' + (onPick ? ' clickable' : '')} onMouseEnter={() => setHover(i)} onClick={() => onPick?.(d.label)}>
          <span className="col-value">{hover === i || data.length <= 8 ? fmt(d.value, format, currency) : ''}</span>
          <span className="col-track"><span className="col-fill" style={{ height: `${Math.max((d.value / max) * 100, d.value > 0 ? 1.5 : 0)}%` }} /></span>
          <span className="col-label" title={d.label}>{d.label}</span>
          {hover === i && <span className="viz-tip" role="tooltip"><b>{d.label}</b><br />{fmt(d.value, format, currency, false)}</span>}
        </div>
      ))}
    </div>
  );
}

/** A few series over time; legend plus direct labels at the line ends. */
export function MultiLine({ p, format, currency, area }: { p: Pivot; format: VizFormat; currency?: string; area?: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const multi = p.series.length > 1;
  const W = 640, H = 220, L = 56, R = multi ? 96 : 16, T = 12, B = 28;
  const max = Math.max(...p.values.flat(), 0) || 1;
  const x = (i: number) => L + (p.labels.length === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (p.labels.length - 1));
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  const paths = useMemo(() => p.series.map((_, si) => p.labels.map((__, li) => `${li ? 'L' : 'M'}${x(li).toFixed(1)},${y(p.values[li][si]).toFixed(1)}`).join(' ')), [p]);
  if (!p.labels.length) return <div className="viz-empty">No data for this period.</div>;
  return (
    <div className="line-wrap">
      {p.series.length > 1 && <Legend series={p.series} />}
      <svg viewBox={`0 0 ${W} ${H}`} className="line-svg" role="img" aria-label={`Trend of ${p.series.join(', ')}`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          let best = 0;
          p.labels.forEach((_, i) => { if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i; });
          setHover(best);
        }}>
        {[0, max / 2, max].map((t) => (
          <g key={t}><line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className="grid" /><text x={L - 8} y={y(t) + 4} className="axis" textAnchor="end">{fmt(t, format, currency)}</text></g>
        ))}
        {p.labels.map((l, i) => (p.labels.length <= 12 || i % 2 === 0) && <text key={l} x={x(i)} y={H - 8} className="axis" textAnchor="middle">{l}</text>)}
        {area && p.series.length === 1 && <path d={`${paths[0]} L${x(p.labels.length - 1)},${y(0)} L${x(0)},${y(0)} Z`} className="series-area" />}
        {paths.map((d, si) => <path key={si} d={d} fill="none" stroke={color(si)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />)}
        {multi && p.series.map((s, si) => (
          <text key={s} x={W - R + 6} y={y(p.values[p.labels.length - 1][si]) + 4} className="direct-label" fill="currentColor">{s.length > 14 ? `${s.slice(0, 13)}…` : s}</text>
        ))}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} className="crosshair" />}
        {hover !== null && p.series.map((s, si) => <circle key={s} cx={x(hover)} cy={y(p.values[hover][si])} r={4.5} fill={color(si)} stroke="var(--surface)" strokeWidth={2} />)}
      </svg>
      {hover !== null && (
        <div className="viz-tip floating" style={{ left: `${(x(hover) / W) * 100}%` }} role="tooltip">
          <b>{p.labels[hover]}</b>
          {p.series.map((s, si) => <div key={s}><i className="tip-swatch" style={{ background: color(si) }} />{p.series.length > 1 ? `${s}: ` : ''}{fmt(p.values[hover][si], format, currency, false)}</div>)}
        </div>
      )}
    </div>
  );
}

/** "Account.Name" → "Account name", "CloseDate" → "Close date", "cnt" stays readable enough. */
export function humanize(c: string): string {
  const parts = c.split('.').map((p) => p.replace(/__c$/, '').replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2'));
  const last = parts.length > 1 && /^name$/i.test(parts[parts.length - 1]) ? parts.slice(0, -1) : parts; // Account.Name → Account
  const t = last.join(' ').toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Sortable table with CSV export: the accessible view of every tile. */
export function SortTable({ columns, rows, format, currency, title }: { columns: string[]; rows: Record<string, unknown>[]; format?: (c: string, v: unknown) => string; currency?: string; title: string }) {
  const [sort, setSort] = useState<{ c: string; dir: 1 | -1 } | null>(null);
  const shown = useMemo(() => {
    if (!sort) return rows;
    return [...rows].sort((a, b) => {
      const x = a[sort.c], y = b[sort.c];
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? ''))) * sort.dir;
    });
  }, [rows, sort]);
  const csv = () => {
    const esc = (v: unknown) => { const s = v === undefined || v === null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const text = [columns.join(','), ...rows.map((r) => columns.map((c) => esc(r[c])).join(','))].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    a.download = `${title.replace(/[^\w]+/g, '_')}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  if (!rows.length) return <div className="viz-empty">No rows for this period.</div>;
  return (
    <div>
      <div className="viz-table-wrap">
        <table className="viz-table">
          <thead><tr>{columns.map((c) => (
            <th key={c} onClick={() => setSort((s) => ({ c, dir: s?.c === c && s.dir === 1 ? -1 : 1 }))} className="sortable">
              {humanize(c)}{sort?.c === c ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
            </th>
          ))}</tr></thead>
          <tbody>{shown.map((r, i) => <tr key={i}>{columns.map((c) => <td key={c} className={typeof r[c] === 'number' ? 'num' : undefined}>{format ? format(c, r[c]) : String(r[c] ?? '')}</td>)}</tr>)}</tbody>
        </table>
      </div>
      <button className="ghost sm" onClick={csv} style={{ marginTop: 6 }}>Download CSV</button>
    </div>
  );
}
