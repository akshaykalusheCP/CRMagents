import { allowed, apiLevel, assertBudget } from '../salesforce/limits.js';
import { config } from '../config.js';
import { pool } from '../db.js';
import type { SalesforceClient } from '../salesforce/client.js';
import { logSpend, runSoql, safeSoql, schemaContext, setup } from './ai.js';

// Prompt-built dashboards. The AI drafts tiles once (one call, plus one repair call if a query fails);
// saved dashboards re-run their queries with a dashboard-wide date filter and cost $0 in AI from then on.

export const CHARTS = ['kpi', 'bar', 'column', 'line', 'area', 'stacked', 'multiline', 'table'] as const;
export type ChartKind = (typeof CHARTS)[number];
export const RANGES = ['all', 'THIS_MONTH', 'LAST_MONTH', 'THIS_QUARTER', 'LAST_QUARTER', 'THIS_YEAR', 'LAST_YEAR', 'LAST_N_DAYS:30', 'LAST_N_DAYS:90', 'LAST_N_DAYS:365'] as const;
export type Range = (typeof RANGES)[number];

export interface TileSpec {
  title: string;
  question: string;
  soql: string;
  chart: ChartKind;
  label_key: string;
  series_key: string;
  value_key: string;
  format: 'currency' | 'number' | 'percent';
  date_field: string;
  drill_soql: string;
  size: 'third' | 'half' | 'full';
}

// ---------- Date filter injection (pure, tested) ----------

/** Positions of top-level SOQL keywords (outside parentheses and string literals). */
function topLevel(soql: string, re: RegExp): number {
  let depth = 0;
  let quote = false;
  for (let i = 0; i < soql.length; i++) {
    const ch = soql[i];
    if (quote) { if (ch === '\\') i++; else if (ch === "'") quote = false; continue; }
    if (ch === "'") { quote = true; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && /\s/.test(ch)) {
      const m = re.exec(soql.slice(i + 1));
      if (m && m.index === 0) return i + 1;
    }
  }
  return -1;
}

/** Adds "<field> = <RANGE>" to the main query's WHERE clause, keeping existing conditions grouped. */
export function applyDateFilter(soql: string, field: string, range: Range | string): string {
  if (!field || !range || range === 'all') return soql;
  if (!/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)?$/.test(field)) throw new Error(`Invalid date field ${field}`);
  if (!(RANGES as readonly string[]).includes(range)) throw new Error(`Invalid date range ${range}`);
  const cond = `${field} = ${range}`;
  const tail = ['GROUP\\s+BY', 'HAVING', 'ORDER\\s+BY', 'LIMIT', 'OFFSET'].map((k) => topLevel(soql, new RegExp(`${k}\\b`, 'i'))).filter((i) => i >= 0);
  const end = tail.length ? Math.min(...tail) : soql.length;
  const where = topLevel(soql, /WHERE\b/i);
  if (where >= 0 && where < end) {
    const existing = soql.slice(where + 5, end).trim();
    return `${soql.slice(0, where)}WHERE ${cond} AND (${existing}) ${soql.slice(end)}`.trim();
  }
  return `${soql.slice(0, end).trimEnd()} WHERE ${cond} ${soql.slice(end)}`.trim();
}

const soqlLiteral = (v: string) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

// ---------- Drafting with AI ----------

const DRAFT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['name', 'description', 'tiles', 'questions'],
  properties: {
    name: { type: 'string' },
    description: { type: 'string', description: 'One sentence' },
    questions: { type: 'array', items: { type: 'string' }, description: 'Only if the request is too vague; otherwise empty' },
    tiles: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['title', 'question', 'soql', 'chart', 'label_column', 'series_column', 'value_column', 'format', 'date_field', 'drill_soql'],
        properties: {
          title: { type: 'string' },
          question: { type: 'string', description: 'The plain-English question this tile answers' },
          soql: { type: 'string', description: 'One read-only SOQL query; aggregates with aliases; LIMIT <= 200. No date range for the dashboard period (added by the filter).' },
          chart: { type: 'string', enum: [...CHARTS], description: 'kpi=one number; bar=compare categories (horizontal); column=time buckets or few categories; line/area=trend over time; stacked=part-to-whole across two dimensions; multiline=trend of a few series; table=list of records' },
          label_column: { type: 'string', description: 'Result column for categories/time; empty for kpi/table' },
          series_column: { type: 'string', description: 'Second dimension for stacked/multiline; else empty' },
          value_column: { type: 'string', description: 'Numeric result column (alias); empty for table' },
          format: { type: 'string', enum: ['currency', 'number', 'percent'] },
          date_field: { type: 'string', description: 'Date/datetime field of the FROM object that the dashboard period applies to (e.g. CloseDate, CreatedDate); empty if the tile is not time-bound (e.g. current open pipeline)' },
          drill_soql: { type: 'string', description: 'For bar/column/stacked tiles: SELECT Id plus 3-5 useful fields FROM the same object with the same filters AND <the field behind label_column> = :label LIMIT 50. Empty otherwise.' },
        },
      },
    },
  },
};

const SYSTEM = `You design Salesforce dashboards for business users. For the request, design 3-8 tiles that together answer it well: start with 1-3 KPI tiles for the headline numbers, then charts, then at most one record table.
Write valid SOQL against only the listed objects/fields: GROUP BY with aggregate aliases (e.g. SUM(Amount) amount), CALENDAR_MONTH/CALENDAR_YEAR or DAY_ONLY for time buckets, relationship fields like Account.Name, Owner.Name. Order results meaningfully. Put the time bucket first in GROUP BY for trends.
Never hard-code the dashboard period in the WHERE clause; set date_field instead (the dashboard adds the period filter). Keep business conditions (e.g. IsWon = true, IsClosed = false) in WHERE.
Pick the clearest chart: never more than ~8 categories in a bar/column (use LIMIT or a table); stacked only for part-to-whole with a second dimension of <= 6 values.`;

export interface DraftResult {
  name: string; description: string; questions: string[]; warnings: string[]; costUsd: number;
  tiles: (TileSpec & { columns: string[]; rows: Record<string, unknown>[] })[];
}

function toSpec(t: any): TileSpec {
  return {
    title: String(t.title ?? 'Tile'), question: String(t.question ?? ''), soql: safeSoql(String(t.soql ?? '')),
    chart: (CHARTS as readonly string[]).includes(t.chart) ? t.chart : 'table',
    label_key: String(t.label_column ?? ''), series_key: String(t.series_column ?? ''), value_key: String(t.value_column ?? ''),
    format: ['currency', 'number', 'percent'].includes(t.format) ? t.format : 'number',
    date_field: /^[A-Za-z_]\w*$/.test(String(t.date_field ?? '')) ? String(t.date_field) : '',
    drill_soql: String(t.drill_soql ?? ''),
    size: t.chart === 'kpi' ? 'third' : t.chart === 'table' || t.chart === 'stacked' || t.chart === 'multiline' ? 'full' : 'half',
  };
}

/** Aggregates come back with Salesforce's own names (e.g. Account.Name -> Name); map the spec to real columns. */
function resolveKeys(t: TileSpec, columns: string[]): TileSpec {
  const find = (want: string) => {
    if (!want) return '';
    // Fall back to the requested name: empty aggregates (e.g. SUM of blank amounts) are left out of results,
    // and the chart treats a missing value as zero rather than losing the column.
    return columns.find((c) => c === want) ?? columns.find((c) => c.toLowerCase() === want.toLowerCase())
      ?? columns.find((c) => c.toLowerCase() === want.split('.').pop()!.toLowerCase()) ?? want.split('.').pop()!;
  };
  return { ...t, label_key: find(t.label_key), series_key: find(t.series_key), value_key: find(t.value_key) };
}

async function check(sf: SalesforceClient, t: TileSpec, range: Range) {
  const data = await runSoql(sf, applyDateFilter(t.soql, t.date_field, range));
  const spec = resolveKeys(t, data.columns);
  // Drill query must actually run; otherwise drop it rather than ship a broken click.
  if (spec.drill_soql && spec.label_key && data.rows.length) {
    try {
      const probe = spec.drill_soql.replace(/:label\b/g, soqlLiteral(String(data.rows[0][spec.label_key] ?? '')));
      await runSoql(sf, applyDateFilter(probe, spec.date_field, range));
    } catch { spec.drill_soql = ''; }
  } else spec.drill_soql = '';
  return { ...spec, ...data };
}

export async function draftDashboard(tenantId: string, prompt: string, opts: { maxTiles?: number; range?: Range } = {}): Promise<DraftResult> {
  const { llm, sf } = await setup(tenantId);
  const range = opts.range ?? 'THIS_YEAR';
  const { candidates, schema } = await schemaContext(tenantId, sf, prompt, 4);
  const one = opts.maxTiles === 1;
  const system = one ? `${SYSTEM}\nDesign exactly ONE tile.` : SYSTEM;
  let ask = `Request: ${prompt}\n\nObjects available: ${candidates.slice(0, 25).join(', ')}\nFields:\n${schema.join('\n')}`;

  let cost = 0;
  const warnings: string[] = [];
  let ok: DraftResult['tiles'] = [];
  let meta = { name: '', description: '', questions: [] as string[] };
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await llm.complete({ system, prompt: ask, schema: DRAFT_SCHEMA, model: config.insightsModel });
    cost += r.usage.costUsd;
    const j = JSON.parse(r.text);
    if (attempt === 0) meta = { name: j.name, description: j.description, questions: j.questions ?? [] };
    const failed: { tile: any; error: string }[] = [];
    for (const raw of (j.tiles ?? []).slice(0, one ? 1 : 8)) {
      try { ok.push(await check(sf, toSpec(raw), range)); }
      catch (e) { failed.push({ tile: raw, error: e instanceof Error ? e.message.replace(/^Salesforce GET \S+ -> /, '').slice(0, 300) : String(e) }); }
    }
    if (!failed.length) break;
    if (attempt === 1) { failed.forEach((f) => warnings.push(`Left out "${f.tile.title}": ${f.error}`)); break; }
    // Repair only the tiles that failed; the good ones are kept as they are.
    ask = `Request: ${prompt}\n\nFields:\n${schema.join('\n')}\n\nThese tiles' queries failed; return corrected versions of ONLY these tiles (same titles):\n${failed.map((f) => `- ${f.tile.title}: ${f.tile.soql}\n  Error: ${f.error}`).join('\n')}`;
  }
  await logSpend(tenantId, 'dashboard', prompt, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: cost });
  return { ...meta, tiles: ok, warnings, costUsd: cost };
}

// ---------- Saved dashboards ----------

// Tile results are kept for 10 minutes: reopening a dashboard or switching tabs costs no API calls. While the org's
// API allowance runs low, the last results are shown whatever their age.
const TILE_TTL = 10 * 60_000;
const tileCache = new Map<string, { at: number; data: Awaited<ReturnType<typeof runSoql>> }>();

export async function runTiles(sf: SalesforceClient, tiles: (TileSpec & { id: string })[], range: Range, refresh = false) {
  const low = !allowed(apiLevel(sf.tenantId), 'background');
  // All tiles' queries start together, so they reach Salesforce as one composite batch (one API call per 25).
  return Promise.all(tiles.map(async (t) => {
    const soql = applyDateFilter(t.soql, t.date_field, range);
    const key = `${sf.tenantId}|${soql}`;
    const hit = tileCache.get(key);
    if (hit && (low || (!refresh && Date.now() - hit.at < TILE_TTL))) return { ...t, ...hit.data, cachedAt: new Date(hit.at).toISOString() };
    try {
      if (low) assertBudget(sf.tenantId, 'background');
      const data = await runSoql(sf, soql);
      tileCache.set(key, { at: Date.now(), data });
      if (tileCache.size > 2000) tileCache.delete(tileCache.keys().next().value!);
      return { ...t, ...data };
    } catch (e) { return { ...t, columns: [], rows: [], error: e instanceof Error ? e.message.replace(/^Salesforce GET \S+ -> /, '').slice(0, 300) : String(e) }; }
  }));
}

export async function drill(sf: SalesforceClient, tile: TileSpec, label: string, range: Range) {
  if (!tile.drill_soql) throw new Error('This tile has no drill-down');
  return runSoql(sf, applyDateFilter(tile.drill_soql.replace(/:label\b/g, soqlLiteral(label)), tile.date_field, range));
}

export async function saveTiles(dashboardId: string, tiles: TileSpec[]) {
  await pool.query('delete from dashboard_tiles where dashboard_id=$1', [dashboardId]);
  for (const [i, t] of tiles.entries()) {
    await pool.query(
      `insert into dashboard_tiles (dashboard_id, position, title, question, soql, chart, label_key, series_key, value_key, format, date_field, drill_soql, size)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [dashboardId, i, t.title, t.question, safeSoql(t.soql), t.chart, t.label_key, t.series_key, t.value_key, t.format, t.date_field, t.drill_soql, t.size],
    );
  }
}
