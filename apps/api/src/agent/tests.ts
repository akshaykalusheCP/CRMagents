import { config } from '../config.js';
import { asText, parseJsonLoose } from './llm.js';
import { pool } from '../db.js';
import { logSpend, setup } from '../insights/ai.js';
import { websiteSpec } from './publicChat.js';
import { runAgent } from './runner.js';
import { TOOLS } from './tools.js';

// Test sets for assistants: questions people really ask, each with what a good answer says (and words it must or
// must not contain). Running the set asks every question for real, reading Salesforce and the guides as usual,
// but nothing is changed or sent: tools that write, open cases or email visitors are answered with "not run in a
// test". Each answer is checked by the word rules (free, exact) and, when an expected answer is given, by a small,
// cheap AI judge. Results are kept so a change to the assistant can be compared with the last run.

export const MAX_TESTS = 30;

export interface TestCase { id: string; question: string; expect: string; mustInclude: string[]; mustNot: string[] }
export interface TestResult {
  testId: string; question: string; answer: string; pass: boolean; reasons: string[];
  tools: string[]; costUsd: number; ms: number;
}

/** Word rules, case-insensitive. Pure; tested. */
export function wordChecks(answer: string, mustInclude: string[], mustNot: string[]): string[] {
  const a = answer.toLowerCase();
  const out: string[] = [];
  for (const w of mustInclude.map((x) => x.trim()).filter(Boolean)) if (!a.includes(w.toLowerCase())) out.push(`Missing "${w}"`);
  for (const w of mustNot.map((x) => x.trim()).filter(Boolean)) if (a.includes(w.toLowerCase())) out.push(`Says "${w}", which it must not`);
  return out;
}

/** In a test nothing is changed or sent: the tools that would are answered without running. Pure; tested. */
export function simulated(name: string, input: unknown): string | undefined {
  const t = TOOLS[name];
  const sideEffect = t?.write || t?.publicOnly || ['open_case', 'talk_to_person'].includes(name);
  if (!sideEffect) return undefined;
  return `(Test run: "${name}" was not run, because tests never change data or contact anyone. It would have been called with ${JSON.stringify(input).slice(0, 500)}. Answer as if it succeeded.)`;
}

const JUDGE_SCHEMA = {
  type: 'object',
  properties: { pass: { type: 'boolean' }, reason: { type: 'string', description: 'One short sentence: what is wrong, or why it is fine.' } },
  required: ['pass', 'reason'],
  additionalProperties: false,
};

const JUDGE_SYSTEM = `You check an assistant's answer against what a good answer should say.
Pass it when it gives the same facts and outcome as the expected answer, even in other words, shorter or longer.
Fail it when it contradicts the expected answer, leaves out its key point, makes up facts, or refuses when it should answer.
Ignore tone and formatting.`;

export async function listTests(agentId: string): Promise<TestCase[]> {
  const { rows } = await pool.query(
    `select id, question, expect, must_include as "mustInclude", must_not as "mustNot" from assistant_tests where agent_id=$1 order by created_at`, [agentId]);
  return rows;
}

export async function saveTest(agentId: string, t: Omit<TestCase, 'id'>, id?: string) {
  if (id) {
    const r = await pool.query('update assistant_tests set question=$3, expect=$4, must_include=$5, must_not=$6 where id=$2 and agent_id=$1',
      [agentId, id, t.question, t.expect, t.mustInclude, t.mustNot]);
    if (!r.rowCount) throw Object.assign(new Error('Test not found'), { statusCode: 404 });
    return { id };
  }
  const { rows: n } = await pool.query('select count(*)::int n from assistant_tests where agent_id=$1', [agentId]);
  if (n[0].n >= MAX_TESTS) throw Object.assign(new Error(`A test set holds up to ${MAX_TESTS} questions.`), { statusCode: 400 });
  const { rows } = await pool.query('insert into assistant_tests (agent_id, question, expect, must_include, must_not) values ($1,$2,$3,$4,$5) returning id',
    [agentId, t.question, t.expect, t.mustInclude, t.mustNot]);
  return { id: rows[0].id as string };
}

export async function deleteTest(agentId: string, id: string) {
  await pool.query('delete from assistant_tests where id=$2 and agent_id=$1', [agentId, id]);
}

/** Questions people asked this assistant recently (to turn into tests). */
export async function recentQuestions(tenantId: string, agentId: string) {
  const { rows } = await pool.query(
    `select distinct on (q) q, answer, created_at from (
       select input->>'userInput' as q, output as answer, created_at from runs
       where tenant_id=$1 and agent_id=$2 and status='done' and coalesce(started_by,'') not like 'test:%' and input->>'userInput' is not null
       order by created_at desc limit 200) x
     where length(q) between 3 and 2000 order by q, created_at desc`, [tenantId, agentId]);
  const have = new Set((await listTests(agentId)).map((t) => t.question.trim().toLowerCase()));
  return rows.filter((r) => !have.has(r.q.trim().toLowerCase()))
    .sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at)).slice(0, 15)
    .map((r) => ({ question: r.q as string, answer: String(r.answer ?? '').slice(0, 1500) }));
}

export async function listTestRuns(agentId: string) {
  const { rows } = await pool.query(
    `select id, channel, status, passed, total, cost_usd::float as "costUsd", results, started_by as "startedBy", created_at as "createdAt", finished_at as "finishedAt"
     from assistant_test_runs where agent_id=$1 order by created_at desc limit 10`, [agentId]);
  return rows;
}

/** Start a test run in the background; returns its id at once. */
export async function startTestRun(tenantId: string, agentId: string, channel: 'internal' | 'website', who: string) {
  const { rows: a } = await pool.query('select id, system_prompt, tools, public_cases, public_config from agents where id=$1 and tenant_id=$2', [agentId, tenantId]);
  if (!a[0]) throw Object.assign(new Error('Assistant not found'), { statusCode: 404 });
  const tests = await listTests(agentId);
  if (!tests.length) throw Object.assign(new Error('Add a test question first.'), { statusCode: 400 });
  const { rows: busy } = await pool.query("select 1 from assistant_test_runs where agent_id=$1 and status='running' and created_at > now() - interval '15 minutes'", [agentId]);
  if (busy.length) throw Object.assign(new Error('A test run is already going for this assistant.'), { statusCode: 409 });
  const { rows } = await pool.query('insert into assistant_test_runs (agent_id, channel, total, started_by) values ($1,$2,$3,$4) returning id',
    [agentId, channel, tests.length, who]);
  const runId = rows[0].id as string;
  const spec = channel === 'website' ? websiteSpec(a[0]) : { id: a[0].id, systemPrompt: a[0].system_prompt, tools: a[0].tools };
  void runTests(tenantId, runId, spec, tests, who).catch(async (e) => {
    await pool.query("update assistant_test_runs set status='error', finished_at=now(), results=$2 where id=$1",
      [runId, JSON.stringify([{ error: e instanceof Error ? e.message : String(e) }])]);
  });
  return { id: runId };
}

async function runTests(tenantId: string, runId: string, spec: { id: string; systemPrompt: string; tools: string[] }, tests: TestCase[], who: string) {
  const { llm } = await setup(tenantId);
  const results: TestResult[] = [];
  let cost = 0;
  for (const t of tests) {
    const t0 = Date.now();
    let answer = '';
    let tools: string[] = [];
    let runCost = 0;
    const reasons: string[] = [];
    try {
      const r = await runAgent(tenantId, spec, t.question, undefined, undefined, {
        startedBy: `test:${who}`, meta: { channel: 'test', testRunId: runId },
        exec: (name, input) => { const s = simulated(name, input); return s === undefined ? undefined : Promise.resolve(s); },
      });
      answer = r.output;
      const { rows } = await pool.query('select trace, cost_usd::float as cost from runs where id=$1', [r.runId]);
      tools = [...new Set(((rows[0]?.trace ?? []) as { tool: string }[]).map((x) => x.tool))];
      runCost = rows[0]?.cost ?? 0;
    } catch (e) {
      reasons.push(`The assistant failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (answer) reasons.push(...wordChecks(answer, t.mustInclude, t.mustNot));
    if (answer && t.expect.trim()) {
      try {
        const j = await llm.complete({
          system: JUDGE_SYSTEM, schema: JUDGE_SCHEMA, model: config.builderModel,
          prompt: `Question: ${t.question}\n\nExpected answer:\n${t.expect}\n\nAssistant's answer:\n${answer.slice(0, 6000)}`,
        });
        const p = parseJsonLoose(j.text);
        const v = { pass: p.pass === true, reason: asText(p.reason) || 'The answer did not match what was expected.' };
        if (!j.reused) { runCost += j.usage.costUsd; await logSpend(tenantId, 'assistant test', t.question, j.usage); }
        if (!v.pass) reasons.push(v.reason);
      } catch (e) {
        reasons.push(`Could not check the answer: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    cost += runCost;
    results.push({ testId: t.id, question: t.question, answer, pass: !!answer && !reasons.length, reasons, tools, costUsd: runCost, ms: Date.now() - t0 });
    await pool.query('update assistant_test_runs set results=$2, passed=$3, cost_usd=$4 where id=$1',
      [runId, JSON.stringify(results), results.filter((r) => r.pass).length, cost]);
  }
  await pool.query("update assistant_test_runs set status='done', finished_at=now() where id=$1", [runId]);
}
