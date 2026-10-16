import { Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

// The app's building blocks. Pages compose these instead of styling their own boxes, so spacing, borders and
// states stay the same everywhere. Cards are for separate objects only; sections are plain panels with a header.

export function PageHeader({ title, description, actions, children }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <header className="ph">
      <div className="ph-row">
        <div className="ph-text">
          <h1 className="ph-title">{title}</h1>
          {description && <p className="ph-desc">{description}</p>}
        </div>
        {actions && <div className="ph-actions">{actions}</div>}
      </div>
      {children && <div className="ph-below">{children}</div>}
    </header>
  );
}

export function Panel({ title, action, children, flush, className = '' }: { title?: ReactNode; action?: ReactNode; children: ReactNode; flush?: boolean; className?: string }) {
  return (
    <section className={`panel ${flush ? 'flush' : ''} ${className}`}>
      {(title || action) && <div className="panel-head"><h2>{title}</h2>{action}</div>}
      <div className="panel-body">{children}</div>
    </section>
  );
}

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral';
export function Status({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return <span className={`status ${tone}`} title={title}><i />{children}</span>;
}

export function FilterTabs<T extends string>({ options, value, onChange }: { options: { id: T; label: string; count?: number }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="ftabs" role="tablist">
      {options.map((o) => (
        <button key={o.id} role="tab" aria-selected={value === o.id} className={value === o.id ? 'on' : ''} onClick={() => onChange(o.id)}>
          {o.label}{o.count !== undefined && <span className="ftab-count">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

export interface Column<T> { key: string; header: ReactNode; render: (row: T) => ReactNode; align?: 'left' | 'right'; width?: string; hideSm?: boolean }

/** List table: hover rows, whole row clickable, numbers right-aligned. */
export function Table<T>({ columns, rows, rowKey, onRowClick, empty, selected }: {
  columns: Column<T>[]; rows: T[]; rowKey: (r: T) => string; onRowClick?: (r: T) => void; empty?: ReactNode; selected?: string;
}) {
  if (!rows.length) return <>{empty}</>;
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead><tr>{columns.map((c) => <th key={c.key} style={{ width: c.width, textAlign: c.align ?? 'left' }} className={c.hideSm ? 'hide-sm' : ''}>{c.header}</th>)}</tr></thead>
        <tbody>
          {rows.map((r) => {
            const k = rowKey(r);
            return (
              <tr key={k} className={(onRowClick ? 'click ' : '') + (selected === k ? 'sel' : '')} onClick={() => onRowClick?.(r)}
                tabIndex={onRowClick ? 0 : undefined} onKeyDown={(e) => { if (onRowClick && e.key === 'Enter') onRowClick(r); }}>
                {columns.map((c) => <td key={c.key} style={{ textAlign: c.align ?? 'left' }} className={c.hideSm ? 'hide-sm' : ''}>{c.render(r)}</td>)}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Left-aligned empty state: says what will appear here and the one thing to do next. */
export function Empty({ title, body, action }: { title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty2">
      <div><b>{title}</b>{body && <p>{body}</p>}</div>
      {action && <div className="empty2-actions">{action}</div>}
    </div>
  );
}

export function Meter({ value, max, label }: { value: number; max: number; label?: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return <div className="meter" role="meter" aria-valuenow={value} aria-valuemax={max} aria-label={label}><span style={{ width: `${pct}%` }} /></div>;
}

/** Click-to-open menu anchored to its button; closes on outside click or Escape. */
export function Menu({ trigger, children, align = 'left', className = '' }: { trigger: (open: boolean) => ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right'; className?: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open]);
  return (
    <div className={`mnu ${className}`}>
      <span onClick={() => setOpen((o) => !o)}>{trigger(open)}</span>
      {open && <><div className="menu-scrim" onClick={() => setOpen(false)} /><div className={`mnu-pop ${align}`} role="menu">{children(() => setOpen(false))}</div></>}
    </div>
  );
}

/** Area trend with a crosshair tooltip (one series, one axis). */
export function Trend({ points, format, height = 180 }: { points: { label: string; value: number }[]; format: (v: number) => string; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640, H = height, L = 8, R = 8, T = 12, B = 24;
  const max = Math.max(...points.map((p) => p.value), 1);
  const x = (i: number) => L + (points.length <= 1 ? 0 : (i * (W - L - R)) / (points.length - 1));
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  return (
    <div className="trend">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Trend"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          setHover(Math.max(0, Math.min(points.length - 1, Math.round(((px - L) / (W - L - R)) * (points.length - 1)))));
        }}>
        <defs><linearGradient id="trendfill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="var(--c1)" stopOpacity=".22" /><stop offset="100%" stopColor="var(--c1)" stopOpacity="0" /></linearGradient></defs>
        <line x1={L} x2={W - R} y1={y(0)} y2={y(0)} className="trend-base" />
        {points.length > 1 && <path d={`${line} L${x(points.length - 1)},${y(0)} L${x(0)},${y(0)} Z`} fill="url(#trendfill)" />}
        <path d={line} fill="none" stroke="var(--c1)" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} className="trend-cross" vectorEffect="non-scaling-stroke" />}
      </svg>
      <div className="trend-axis"><span>{points[0]?.label}</span><span>{points[points.length - 1]?.label}</span></div>
      {hover !== null && points[hover] && (
        <div className="trend-tip" style={{ left: `${(x(hover) / W) * 100}%` }}><b>{format(points[hover].value)}</b><span>{points[hover].label}</span></div>
      )}
    </div>
  );
}

export interface Command { id: string; label: string; hint?: string; group: string; run: () => void }

/** ⌘K palette: type to filter pages and agents, Enter to open. */
export function CommandPalette({ open, onClose, commands }: { open: boolean; onClose: () => void; commands: Command[] }) {
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setQ(''); setI(0); setTimeout(() => input.current?.focus(), 10); } }, [open]);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return commands.filter((c) => !s || c.label.toLowerCase().includes(s) || c.group.toLowerCase().includes(s)).slice(0, 12);
  }, [q, commands]);
  if (!open) return null;
  const run = (c?: Command) => { if (c) { onClose(); c.run(); } };
  let lastGroup = '';
  return (
    <div className="modal cmdk-back" onClick={onClose}>
      <div className="cmdk" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Search">
        <div className="cmdk-input"><Search size={16} />
          <input ref={input} value={q} onChange={(e) => { setQ(e.target.value); setI(0); }} placeholder="Search pages and agents…"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(x + 1, list.length - 1)); }
              if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(x - 1, 0)); }
              if (e.key === 'Enter') run(list[i]);
              if (e.key === 'Escape') onClose();
            }} />
          <kbd>Esc</kbd>
        </div>
        <div className="cmdk-list">
          {!list.length && <div className="cmdk-none">No matches</div>}
          {list.map((c, n) => {
            const head = c.group !== lastGroup ? (lastGroup = c.group) : null;
            return (
              <div key={c.id}>
                {head && <div className="cmdk-group">{head}</div>}
                <button className={'cmdk-item' + (n === i ? ' on' : '')} onMouseEnter={() => setI(n)} onClick={() => run(c)}>
                  <span>{c.label}</span>{c.hint && <span className="cmdk-hint">{c.hint}</span>}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Right-side panel for details, so the list stays in view. Esc or the backdrop closes it. */
export function Drawer({ open, title, sub, onClose, children, footer }: { open: boolean; title: ReactNode; sub?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="sheet-back" onClick={onClose}>
      <aside className="sheet" role="dialog" aria-label={typeof title === 'string' ? title : 'Details'} onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <div className="sheet-title"><h2>{title}</h2>{sub && <div className="sheet-sub">{sub}</div>}</div>
          <button className="ghost icon" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <div className="sheet-body">{children}</div>
        {footer && <footer className="sheet-foot">{footer}</footer>}
      </aside>
    </div>
  );
}

/** Label/value rows for detail panels. */
export function Facts({ items }: { items: [ReactNode, ReactNode][] }) {
  return <dl className="facts">{items.map(([k, v], i) => <div key={i}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}

// ---- Toasts: a short confirmation after an action ("Agent turned on"). One shared queue, no context needed. ----
type ToastItem = { id: number; text: string; tone: 'ok' | 'bad' | 'info' };
let pushToast: ((t: ToastItem) => void) | null = null;
let toastId = 0;
export function toast(text: string, tone: ToastItem['tone'] = 'ok') { pushToast?.({ id: ++toastId, text, tone }); }

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => {
    pushToast = (t) => {
      setItems((x) => [...x.slice(-2), t]);
      setTimeout(() => setItems((x) => x.filter((y) => y.id !== t.id)), 3600);
    };
    return () => { pushToast = null; };
  }, []);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => <div key={t.id} className={`toast ${t.tone}`}><i />{t.text}</div>)}
    </div>
  );
}

/** Placeholder rows while a list loads, shaped like the table that will appear. */
export function SkeletonRows({ rows = 4, cols = 3 }: { rows?: number; cols?: number }) {
  return (
    <div className="skel-table" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skel-row">{Array.from({ length: cols }, (_, j) => <span key={j} className="skel" style={{ width: j === 0 ? '38%' : `${14 + ((i + j) % 3) * 6}%` }} />)}</div>
      ))}
    </div>
  );
}
