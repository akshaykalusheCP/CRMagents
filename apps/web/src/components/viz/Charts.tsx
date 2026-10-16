import { useState, type ReactNode } from 'react';
import type { VizFormat } from '../../api';
import { fmt } from './format';

// Hand-rolled SVG charts following the dataviz method: one validated series hue, thin marks with 4px rounded
// data-ends, recessive grid, a hover tooltip on every mark, and a table view for every chart.

interface Datum { label: string; value: number }
interface Props { data: Datum[]; format: VizFormat; currency?: string }

export function ChartCard({ title, children, table, sub, wide }: { title: string; children: ReactNode; table: ReactNode; sub?: ReactNode; wide?: boolean }) {
  const [asTable, setAsTable] = useState(false);
  return (
    <div className={'card chart-card viz-root' + (wide ? ' wide' : '')}>
      <div className="row between">
        <div><h3>{title}</h3>{sub && <div className="muted small">{sub}</div>}</div>
        <button className="ghost sm" onClick={() => setAsTable((t) => !t)} aria-pressed={asTable}>{asTable ? 'Chart' : 'Table'}</button>
      </div>
      {asTable ? table : children}
    </div>
  );
}

export function DataTable({ columns, rows }: { columns: string[]; rows: ReactNode[][] }) {
  return (
    <div className="viz-table-wrap">
      <table className="viz-table">
        <thead><tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j}>{v}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

/** Horizontal bars: readable category labels, value labels at the bar end, tooltip on hover. */
export function BarChart({ data, format, currency, onPick }: Props & { onPick?: (label: string) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!data.length) return <div className="viz-empty">No data for this period.</div>;
  const max = Math.max(...data.map((d) => d.value), 0) || 1;
  return (
    <div className="bars" onMouseLeave={() => setHover(null)}>
      {data.map((d, i) => (
        <div key={d.label} className={'bar-row' + (hover === i ? ' hot' : '') + (onPick ? ' clickable' : '')} onMouseEnter={() => setHover(i)} onClick={() => onPick?.(d.label)}>
          <span className="bar-label" title={d.label}>{d.label}</span>
          <span className="bar-track">
            <span className="bar-fill" style={{ width: `${Math.max((d.value / max) * 100, d.value > 0 ? 1.5 : 0)}%` }} />
            {hover === i && <span className="viz-tip" role="tooltip"><b>{d.label}</b><br />{fmt(d.value, format, currency, false)}</span>}
          </span>
          <span className="bar-value">{fmt(d.value, format, currency)}</span>
        </div>
      ))}
    </div>
  );
}

/** Single-series trend line with a crosshair + tooltip on hover. */
export function LineChart({ data, format, currency }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  if (!data.length) return <div className="viz-empty">No data for this period.</div>;
  const W = 600, H = 200, L = 56, R = 12, T = 12, B = 28;
  const max = Math.max(...data.map((d) => d.value), 0);
  const top = max > 0 ? niceCeil(max) : 1;
  const x = (i: number) => L + (data.length === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (data.length - 1));
  const y = (v: number) => T + (H - T - B) * (1 - v / top);
  const path = data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.value).toFixed(1)}`).join(' ');
  const ticks = [0, top / 2, top];
  const allZero = max === 0;
  return (
    <div className="line-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} className="line-svg" role="img" aria-label={`Trend: ${data.map((d) => `${d.label} ${fmt(d.value, format, currency)}`).join(', ')}`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          let best = 0;
          data.forEach((_, i) => { if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i; });
          setHover(best);
        }}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className="grid" />
            <text x={L - 8} y={y(t) + 4} className="axis" textAnchor="end">{fmt(t, format, currency)}</text>
          </g>
        ))}
        {data.map((d, i) => <text key={d.label} x={x(i)} y={H - 8} className="axis" textAnchor="middle">{d.label}</text>)}
        <path d={path} className="series-line" />
        {hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} className="crosshair" />
            <circle cx={x(hover)} cy={y(data[hover].value)} r={5} className="series-dot" />
          </g>
        )}
      </svg>
      {hover !== null && (
        <div className="viz-tip floating" style={{ left: `${(x(hover) / W) * 100}%` }} role="tooltip">
          <b>{data[hover].label}</b><br />{fmt(data[hover].value, format, currency, false)}
        </div>
      )}
      {allZero && <div className="viz-note">All zero in this window.</div>}
    </div>
  );
}

function niceCeil(v: number) {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
