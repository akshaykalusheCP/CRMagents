// Records sent to the AI as a CSV table: field names once in a header row instead of repeated in every record.
// SOQL rows all share the same fields, which is where this saves the most.

type Row = Record<string, unknown>;

const isPlainObject = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v);

/** Account: {Name: 'Acme'} becomes "Account.Name"; child subqueries ({records: [...]}) stay as one JSON cell. */
export function flatten(obj: Row, prefix = '', out: Row = {}): Row {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(v) && Array.isArray(v.records)) out[key] = v.records;
    else if (isPlainObject(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function recordsToTable(records: unknown[]): string {
  const rows = records.filter(isPlainObject).map((r) => flatten(r));
  const cols: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  if (!cols.length) return '';
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n');
}
