export type Escape = 'none' | 'soql' | 'json';

function lookup(scope: Record<string, any>, path: string): unknown {
  let cur: any = scope;
  for (const part of path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

function stringify(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string')) return v.join('\n\n---\n\n');
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

const escapers: Record<Escape, (s: string) => string> = {
  none: (s) => s,
  soql: (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'"),
  json: (s) => JSON.stringify(s).slice(1, -1),
};

const RE = /\{\{\s*([\w.[\]]+)\s*(?:\|\s*(\w+)\s*)?\}\}/g;

/** Replace {{path}} placeholders. `escape` protects the surrounding syntax (SOQL string / JSON string). */
export function render(template: unknown, scope: Record<string, any>, escape: Escape = 'none'): string {
  if (typeof template !== 'string') return stringify(template);
  return template.replace(RE, (_m, path: string, filter?: string) => {
    const v = lookup(scope, path);
    const s = filter === 'json' ? JSON.stringify(v) : stringify(v);
    return escapers[escape](s);
  });
}

/** If the template is exactly one {{path}}, return the raw value (arrays/objects intact). */
export function resolveRaw(template: unknown, scope: Record<string, any>): unknown {
  if (typeof template !== 'string') return template;
  const m = /^\s*\{\{\s*([\w.[\]]+)\s*\}\}\s*$/.exec(template);
  if (m) return lookup(scope, m[1]);
  const s = render(template, scope);
  try { return JSON.parse(s); } catch { return s; }
}

export function renderJson(template: unknown, scope: Record<string, any>): Record<string, any> {
  const s = render(template, scope, 'json').trim();
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch { /* fall through */ }
  throw new Error('Expected a JSON object');
}
