// Compares model / effort settings for the Classify and Extract blocks on frozen real data, using the exact
// production block code. Spends real API money - run deliberately.
//   npx tsx --env-file=../../.env evals/model-eval.mts
// Classify: 26 Cases with a human-assigned Case Reason (accuracy vs the human label).
// Extract: 22 Leads scored 0-100 (agreement with the baseline, since there is no human score).
import { readFileSync, writeFileSync } from 'node:fs';
import type { WFNode } from '@crmagents/shared';
import { anthropicClient, createLlm } from '../src/agent/llm.js';
import { addUsage, emptyUsage, type Usage } from '../src/agent/pricing.js';
import { pool } from '../src/db.js';
import { EXECUTORS, type Env } from '../src/engine/nodes.js';
import { rankExamples } from '../src/engine/learn.js';
import { getSetting } from '../src/settings.js';

interface Config { id: string; name: string; model: string; effort: string; escalate?: string; learn?: boolean }
const CONFIGS: Config[] = ([
  { id: 'A', name: 'Opus 5.5, default effort (current)', model: 'default', effort: 'default' },
  { id: 'B', name: 'Haiku 5.5, default effort', model: 'claude-haiku-5-5', effort: 'default' },
  { id: 'C', name: 'Opus 5.5, low effort', model: 'default', effort: 'low' },
  { id: 'D', name: 'Haiku 5.5, Opus when unsure', model: 'claude-haiku-5-5', effort: 'default', escalate: 'when unsure' },
  { id: 'E', name: 'Haiku 5.5 + learned examples (leave-one-out)', model: 'claude-haiku-5-5', effort: 'default', learn: true },
] as Config[]).filter((c) => !process.env.EVAL_CONFIGS || process.env.EVAL_CONFIGS.split(',').includes(c.id));
const RUN_EXTRACT = process.env.EVAL_TASKS !== 'classify';
const CONCURRENCY = 4;

const { reasons, cases } = JSON.parse(readFileSync('evals/data/cases.json', 'utf8'));
const { leads } = JSON.parse(readFileSync('evals/data/leads.json', 'utf8'));

const { rows } = await pool.query("select account_id from users where lower(email)='akshay.kalushe@cloudprism.in'");
const accountId = rows[0].account_id;
const apiKey = (await getSetting(accountId, 'anthropicKey'))!;
const client = anthropicClient(apiKey, await getSetting(accountId, 'anthropicWorkspaceId'));

const node = (type: string, config: Record<string, unknown>): WFNode => ({ id: 'x', type, position: { x: 0, y: 0 }, config });

async function mapLimit<T, R>(items: T[], fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

const classifyNode = (c: Config) => node('ai.classify', {
  text: 'Subject: {{c.Subject}}\nDescription: {{c.Description}}',
  categories: reasons.join('\n'),
  model: c.model, effort: c.effort, escalate: c.escalate ?? 'never',
});
const extractNode = (c: Config) => node('ai.extract', {
  text: '{{lead}}',
  fields: 'score: number 0-100, how likely this lead is to buy\nreason: one-sentence justification',
  model: c.model, effort: c.effort,
});

interface Result { config: Config; classify: { label: string; got: string; ok: boolean; err?: string }[]; extract: { score: number | null; reason: string; err?: string }[]; usage: { classify: Usage; extract: Usage } }

const results: Result[] = [];
for (const cfg of CONFIGS) {
  const env: Env = { sf: {} as never, llm: createLlm(apiKey, {} as never, undefined, client) };
  let uC = emptyUsage();
  let uE = emptyUsage();
  let escalations = 0;
  // The text the classify block sees for a case (same template as classifyNode).
  const caseText = (c: any) => `Subject: ${c.Subject ?? ''}\nDescription: ${c.Description ?? ''}`;
  const classify = await mapLimit(cases, async (cs: any) => {
    try {
      // Learning: examples come from the OTHER cases only, as if an admin had confirmed those earlier.
      const caseEnv: Env = cfg.learn
        ? { ...env, examples: async (_n: string, text: string) => rankExamples(text, cases.filter((o: any) => o !== cs).map((o: any) => ({ input: caseText(o), label: o.Reason }))) }
        : env;
      const r = await EXECUTORS['ai.classify'](classifyNode(cfg), { c: cs }, caseEnv);
      uC = addUsage(uC, r.usage ?? emptyUsage());
      if (r.output.escalated) escalations++;
      return { label: cs.Reason, got: r.output.category, ok: r.output.category === cs.Reason };
    } catch (e) { return { label: cs.Reason, got: '', ok: false, err: String(e) }; }
  });
  const extract = !RUN_EXTRACT ? [] : await mapLimit(leads, async (ld: any) => {
    try {
      const r = await EXECUTORS['ai.extract'](extractNode(cfg), { lead: ld }, env);
      uE = addUsage(uE, r.usage ?? emptyUsage());
      const n = Number(r.output.data?.score);
      return { score: Number.isFinite(n) ? n : null, reason: String(r.output.data?.reason ?? '') };
    } catch (e) { return { score: null, reason: '', err: String(e) }; }
  });
  results.push({ config: cfg, classify, extract, usage: { classify: uC, extract: uE } });
  const acc = classify.filter((x) => x.ok).length;
  console.log(`${cfg.id} ${cfg.name}: classify ${acc}/${cases.length} correct (escalated ${escalations}), $${uC.costUsd.toFixed(4)} | extract $${uE.costUsd.toFixed(4)} | errors ${classify.filter((x) => x.err).length + extract.filter((x) => x.err).length}`);
}

// ---- report ----
const base = results[0];
const hot = (s: number | null) => s !== null && s > 70;
const lines: string[] = [];
lines.push(`# Model / effort comparison - ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, '');
lines.push('## Summary', '', '| Setup | Classify accuracy (vs human Case Reason) | Classify cost (26 cases) | Lead score: same Hot/Not-hot call as A | Avg score difference vs A | Extract cost (22 leads) |', '|---|---|---|---|---|---|');
for (const r of results) {
  const acc = r.classify.filter((x) => x.ok).length;
  const pairs = r.extract.map((x, i) => [x.score, base.extract[i].score] as const).filter(([a, b]) => a !== null && b !== null) as [number, number][];
  const sameHot = pairs.filter(([a, b]) => hot(a) === hot(b)).length;
  const diff = pairs.length ? pairs.reduce((s, [a, b]) => s + Math.abs(a - b), 0) / pairs.length : NaN;
  lines.push(`| ${r.config.id}. ${r.config.name} | ${acc}/${cases.length} (${Math.round((acc / cases.length) * 100)}%) | $${r.usage.classify.costUsd.toFixed(4)} | ${r === base ? '-' : `${sameHot}/${pairs.length}`} | ${r === base ? '-' : diff.toFixed(1)} | $${r.usage.extract.costUsd.toFixed(4)} |`);
}
lines.push('', '## Classify: case by case', '', `| Subject | Human label | ${results.map((r) => r.config.id).join(' | ')} |`, `|---|---|${results.map(() => '---').join('|')}|`);
cases.forEach((cs: any, i: number) => {
  lines.push(`| ${String(cs.Subject).replace(/\|/g, '/')} | ${cs.Reason} | ${results.map((r) => `${r.classify[i].ok ? '✅' : '❌'} ${r.classify[i].got || r.classify[i].err?.slice(0, 40)}`).join(' | ')} |`);
});
if (RUN_EXTRACT) lines.push('', '## Lead scores', '', `| Lead | Rating (human) | ${results.map((r) => `${r.config.id} score`).join(' | ')} |`, `|---|---|${results.map(() => '---').join('|')}|`);
if (RUN_EXTRACT) leads.forEach((ld: any, i: number) => {
  lines.push(`| ${ld.Name} (${ld.Company}) | ${ld.Rating ?? ''} | ${results.map((r) => r.extract[i].score ?? 'error').join(' | ')} |`);
});
const file = `evals/results/model-eval-${Date.now()}.md`;
writeFileSync(file, lines.join('\n') + '\n');
console.log('\n' + lines.slice(2, 4 + results.length + 2).join('\n'));
console.log(`\nFull side-by-side report: apps/api/${file}`);
await pool.end();
