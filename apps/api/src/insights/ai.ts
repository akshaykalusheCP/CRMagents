import { anthropicClient, createLlm, type Llm } from '../agent/llm.js';
import type { Usage } from '../agent/pricing.js';
import { dbResultCache } from '../agent/resultCache.js';
import { config } from '../config.js';
import { pool } from '../db.js';
import { SalesforceClient } from '../salesforce/client.js';
import { detectObjects, fields as describeFields, objects as listObjects } from '../salesforce/schema.js';
import { flatten } from '../salesforce/table.js';
import { getSetting } from '../settings.js';
import { spendGuard } from '../spend.js';
import { accountOf } from '../tenants.js';
import type { Insights } from './metrics.js';

// The AI only ever sees aggregated numbers (summary) or the org schema (questions) - never bulk records.

export async function setup(tenantId: string): Promise<{ llm: Llm; sf: SalesforceClient }> {
  const accountId = await accountOf(tenantId);
  const apiKey = await getSetting(accountId, 'anthropicKey');
  if (!apiKey) throw new Error('Anthropic API key is not configured. Add it in Settings.');
  const sf = await SalesforceClient.forTenant(tenantId);
  const llm = createLlm(apiKey, sf, spendGuard(accountId), anthropicClient(apiKey, await getSetting(accountId, 'anthropicWorkspaceId')), await dbResultCache(accountId));
  return { llm, sf };
}

export async function logSpend(tenantId: string, kind: string, text: string, u: Usage) {
  await pool.query(
    `insert into runs (tenant_id, input, status, output, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
     values ($1,$2,'done',$3,$4,$5,$6,$7,$8)`,
    [tenantId, JSON.stringify({ insights: kind }), text.slice(0, 300), u.input, u.output, u.cacheRead, u.cacheWrite, u.costUsd],
  );
}

/** Compact, readable numbers for the prompt (~1-2k tokens), not raw data. */
function compact(ins: Insights): string {
  const f = (v: number, fmt: string) =>
    fmt === 'currency' ? `${ins.currency} ${Math.round(v).toLocaleString('en-US')}` : fmt === 'percent' ? `${Math.round(v * 100)}%` : fmt === 'days' ? `${v.toFixed(1)} days` : String(Math.round(v * 100) / 100);
  const lines: string[] = [`Period: last ${ins.periodDays} days (compared with the ${ins.periodDays} days before). Today: ${ins.generatedAt.slice(0, 10)}.`];
  for (const s of ins.sections) {
    lines.push(`\n## ${s.title}`);
    s.kpis.forEach((k) => lines.push(`- ${k.label}: ${f(k.value, k.format)}${k.previous !== undefined ? ` (previous period ${f(k.previous, k.format)})` : ''}${k.hint ? ` [${k.hint}]` : ''}`));
    s.charts.forEach((c) => lines.push(`- ${c.title}: ${c.data.map((d) => `${d.label} ${f(d.value, c.format)}`).join('; ') || 'no data'}`));
    s.lists.forEach((l) => l.rows.length && lines.push(`- ${l.title}: ${l.rows.slice(0, 5).map((r) => r.join(' | ')).join('; ')}`));
  }
  return lines.join('\n');
}

export interface Summary {
  headline: string;
  highlights: { title: string; detail: string; tone: 'good' | 'watch' | 'bad' }[];
  actions: { title: string; detail: string }[];
  costUsd: number;
  reused: boolean;
}

const SUMMARY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['headline', 'highlights', 'actions'],
  properties: {
    headline: { type: 'string', description: 'One sentence: the single most important thing about the business right now' },
    highlights: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['title', 'detail', 'tone'],
        properties: { title: { type: 'string' }, detail: { type: 'string' }, tone: { type: 'string', enum: ['good', 'watch', 'bad'] } },
      },
    },
    actions: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['title', 'detail'], properties: { title: { type: 'string' }, detail: { type: 'string' } } },
    },
  },
};

export async function summarize(tenantId: string, ins: Insights): Promise<Summary> {
  const { llm } = await setup(tenantId);
  const r = await llm.complete({
    system: `You brief a busy company owner on their Salesforce numbers. Be brief: they scan, they don't read.
Use only the numbers given. Plain words, no jargon, no filler, no hedging.
- headline: max 14 words, the one thing that matters most.
- highlights: exactly 3. title max 6 words; detail max 12 words with one key number.
- actions: max 3 things to do this week. title max 6 words (start with a verb); detail max 12 words.`,
    prompt: compact(ins),
    schema: SUMMARY_SCHEMA,
    model: config.insightsModel,
  });
  const j = JSON.parse(r.text) as Omit<Summary, 'costUsd' | 'reused'>;
  // Hard caps in case the model runs long: the card must stay scannable.
  const words = (t: string, n: number) => {
    const clean = t.replace(/[\s'"`{}[\]():#,;|]+$/, '').trim(); // models sometimes leave stray JSON/markdown at the end
    const w = clean.split(/\s+/);
    return w.length > n ? `${w.slice(0, n).join(' ').replace(/[,;:]$/, '')}…` : clean;
  };
  j.headline = words(j.headline, 20);
  j.highlights = j.highlights.slice(0, 3).map((h) => ({ ...h, title: words(h.title, 8), detail: words(h.detail, 16) }));
  j.actions = j.actions.slice(0, 3).map((a) => ({ title: words(a.title, 8), detail: words(a.detail, 16) }));
  if (!r.reused) await logSpend(tenantId, 'summary', j.headline, r.usage);
  return { ...j, costUsd: r.usage.costUsd, reused: !!r.reused };
}

// ---------- Questions in plain English ----------

export interface Answer {
  title: string;
  question: string;
  soql: string;
  chart: 'bar' | 'line' | 'table' | 'number';
  labelKey: string;
  valueKey: string;
  explanation: string;
  columns: string[];
  rows: Record<string, unknown>[];
  costUsd: number;
}

const ASK_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['soql', 'title', 'chart', 'label_column', 'value_column', 'explanation'],
  properties: {
    soql: { type: 'string', description: 'One read-only SOQL SELECT. Use aliases for aggregates (e.g. COUNT(Id) total). Include LIMIT (max 200).' },
    title: { type: 'string', description: 'Short chart title' },
    chart: { type: 'string', enum: ['bar', 'line', 'table', 'number'], description: 'bar = compare categories, line = trend over time, number = single value, table = list of records' },
    label_column: { type: 'string', description: 'Result column for categories/time (as it appears in the result, e.g. Account.Name or an alias); empty for number/table' },
    value_column: { type: 'string', description: 'Result column with the numeric value (alias); empty for table' },
    explanation: { type: 'string', description: 'One sentence on what the query measures' },
  },
};

const MAX_ROWS = 200;

/** Read-only guard: one SELECT, no DML keywords, a LIMIT no higher than MAX_ROWS. */
export function safeSoql(soql: string): string {
  const s = soql.trim().replace(/;+\s*$/, '');
  if (!/^select\s/i.test(s)) throw new Error('Only SELECT queries are allowed');
  if (/\b(insert|update|delete|upsert|merge|undelete)\b\s/i.test(s.replace(/'[^']*'/g, "''"))) throw new Error('Only read-only queries are allowed');
  const m = /\blimit\s+(\d+)\s*$/i.exec(s);
  // A total without GROUP BY returns one row, and Salesforce rejects LIMIT on it.
  const total = /^select\s+(count|sum|avg|min|max|count_distinct)\s*\(/i.test(s) && !/\bgroup\s+by\b/i.test(s);
  if (!m) return total ? s : `${s} LIMIT ${MAX_ROWS}`;
  return Number(m[1]) > MAX_ROWS ? s.replace(/\blimit\s+\d+\s*$/i, `LIMIT ${MAX_ROWS}`) : s;
}

export async function runSoql(sf: SalesforceClient, soql: string) {
  const r = await sf.query(safeSoql(soql));
  const rows = (r.records as Record<string, unknown>[]).map((x) => flatten(x));
  const columns: string[] = [];
  rows.forEach((x) => Object.keys(x).forEach((k) => { if (!columns.includes(k)) columns.push(k); }));
  return { columns, rows };
}

/** Objects + fields relevant to a question, compact enough for a prompt. Code picks them ($0). */
export async function schemaContext(tenantId: string, sf: SalesforceClient, text: string, max = 3) {
  const all = await listObjects(tenantId, sf);
  const { mentioned, candidates } = detectObjects(text, all);
  const focus = (mentioned.length ? mentioned : ['Opportunity', 'Account', 'Case', 'Lead']).slice(0, max);
  const schema: string[] = [];
  for (const o of focus) {
    try {
      const fs = await describeFields(tenantId, sf, o);
      schema.push(`${o}: ${fs.map((f) => `${f.name}:${f.type}${f.type === 'reference' && f.referenceTo?.length ? `->${f.referenceTo[0]}` : ''}${f.picklistValues?.length && f.picklistValues.length <= 15 ? `[${f.picklistValues.map((p) => p.value).join('|')}]` : ''}`).join(', ')}`);
    } catch { /* object not accessible */ }
  }
  return { candidates, schema };
}

export async function ask(tenantId: string, question: string): Promise<Answer> {
  const { llm, sf } = await setup(tenantId);
  const all = await listObjects(tenantId, sf);
  const { mentioned, candidates } = detectObjects(question, all);
  const focus = (mentioned.length ? mentioned : ['Opportunity', 'Account', 'Case', 'Lead']).slice(0, 3);
  const schema: string[] = [];
  for (const o of focus) {
    try {
      const fs = await describeFields(tenantId, sf, o);
      schema.push(`${o}: ${fs.map((f) => `${f.name}:${f.type}${f.type === 'reference' && f.referenceTo?.length ? `->${f.referenceTo[0]}` : ''}${f.picklistValues?.length && f.picklistValues.length <= 15 ? `[${f.picklistValues.map((p) => p.value).join('|')}]` : ''}`).join(', ')}`);
    } catch { /* object not accessible */ }
  }
  const system = `You answer business questions about a Salesforce org by writing ONE read-only SOQL query and choosing how to show it.
Rules: valid SOQL only (GROUP BY with aggregates and aliases, date literals like THIS_QUARTER / LAST_N_DAYS:30, relationship fields like Account.Name). Use only the listed objects and fields. Prefer aggregates for "how many / how much / by" questions. Always include LIMIT (max 200). If a field holds money, it is in the org currency.`;
  let prompt = `Question: ${question}\n\nObjects available: ${candidates.slice(0, 25).join(', ')}\nFields:\n${schema.join('\n')}`;

  let total = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await llm.complete({ system, prompt, schema: ASK_SCHEMA, model: config.insightsModel });
    total += r.usage.costUsd;
    const j = JSON.parse(r.text) as { soql: string; title: string; chart: Answer['chart']; label_column: string; value_column: string; explanation: string };
    try {
      const { columns, rows } = await runSoql(sf, j.soql);
      const pick = (want: string, fallback?: string) => columns.find((c) => c === want) ?? columns.find((c) => c.toLowerCase() === want.toLowerCase()) ?? fallback ?? '';
      const valueKey = pick(j.value_column, columns.find((c) => rows.some((x) => typeof x[c] === 'number')));
      const labelKey = pick(j.label_column, columns.find((c) => c !== valueKey));
      await logSpend(tenantId, 'ask', question, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: total });
      return { title: j.title, question, soql: safeSoql(j.soql), chart: j.chart, labelKey, valueKey, explanation: j.explanation, columns, rows, costUsd: total };
    } catch (e) {
      if (attempt === 1) throw new Error(`Couldn't answer that from your data: ${e instanceof Error ? e.message.replace(/^Salesforce GET \S+ -> /, '').slice(0, 200) : e}`);
      prompt += `\n\nYour previous query failed:\n${j.soql}\nError: ${e instanceof Error ? e.message.slice(0, 300) : e}\nReturn a corrected query.`;
    }
  }
  throw new Error('unreachable');
}
