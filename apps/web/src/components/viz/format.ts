import type { VizFormat } from '../../api';

const compact = (n: number) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);

export function fmt(v: number, f: VizFormat, currency = 'USD', short = true): string {
  if (!Number.isFinite(v)) return '–';
  switch (f) {
    case 'currency':
      return short && Math.abs(v) >= 10_000
        ? `${new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(0).replace(/0/, '')}${compact(v)}`
        : new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(v);
    case 'percent': return `${Math.round(v * 100)}%`;
    case 'days': return `${v.toFixed(1)} days`;
    default: return short && Math.abs(v) >= 10_000 ? compact(v) : new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(v);
  }
}
