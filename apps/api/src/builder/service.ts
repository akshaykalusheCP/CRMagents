import type { Workflow } from '@crmagents/shared';
import { anthropicClient, createLlm } from '../agent/llm.js';
import { addUsage, emptyUsage, type Usage } from '../agent/pricing.js';
import { dbResultCache } from '../agent/resultCache.js';
import { config } from '../config.js';
import { pool } from '../db.js';
import { SalesforceClient } from '../salesforce/client.js';
import { actionContext, describeOrgAction, listOrgActions, parseActionKey, rankActions } from '../salesforce/actions.js';
import { detectObjects, fields as describeFields, objects as listObjects } from '../salesforce/schema.js';
import { getSetting } from '../settings.js';
import { spendGuard } from '../spend.js';
import { accountOf } from '../tenants.js';
import { compilePlan } from './compile.js';
import { conflicts, orgAutomation, rulesContext } from '../smart/orgAutomation.js';
import { PLANNER_SYSTEM, planSchema, type Plan } from './plan.js';

export interface Draft {
  name: string;
  plan: Plan;
  workflow: Workflow;
  summary: string[];
  estimateUsd: number;
  warnings: string[];
  errors: string[];
  questions: string[];
  sample?: { recordId: string; objectApiName: string };
  builderCostUsd: number;
}

const MAX_ATTEMPTS = 2; // first draft + at most one automatic repair

/** One compact line per field; picklist values only for short lists. */
function fieldContext(fs: Awaited<ReturnType<typeof describeFields>>): string {
  return fs.map((f) => {
    const pick = f.picklistValues?.length && f.picklistValues.length <= 60 ? ` [${f.picklistValues.map((p) => p.value).join('|')}]` : '';
    return `${f.name}:${f.type}${pick}`;
  }).join('\n');
}

/**
 * Plain-English request -> validated workflow draft. Code finds the objects and fields, one small structured AI
 * call writes the plan, code compiles and validates it against the org (one repair call if needed).
 * Pass `current` to change an existing draft ("also notify Slack").
 */
export async function draftWorkflow(tenantId: string, request: string, current?: Plan): Promise<Draft> {
  const accountId = await accountOf(tenantId);
  const apiKey = await getSetting(accountId, 'anthropicKey');
  if (!apiKey) throw new Error('Anthropic API key is not configured. Add it in Settings.');
  const sf = await SalesforceClient.forTenant(tenantId);
  const llm = createLlm(apiKey, sf, spendGuard(accountId), anthropicClient(apiKey, await getSetting(accountId, 'anthropicWorkspaceId')), await dbResultCache(accountId));

  // ---- code: which objects and fields are we talking about ($0, cached) ----
  const all = await listObjects(tenantId, sf);
  const { mentioned, candidates } = detectObjects(`${request} ${current?.trigger_object ?? ''}`, all);
  let primary = current?.trigger_object || mentioned[0] || '';
  const objectNames = [...new Set([primary, ...candidates].filter(Boolean))];

  // ---- code: the org's own actions that match the request ($0, cached) ----
  const orgActions = await listOrgActions(tenantId, sf).catch(() => []);
  const inUse = new Set((current?.steps ?? []).map((s) => s.org_action).filter(Boolean) as string[]);
  const picked = [
    ...orgActions.filter((a) => inUse.has(`${a.kind}:${a.name}`)),
    ...rankActions(request, orgActions).filter((a) => !inUse.has(`${a.kind}:${a.name}`)),
  ].slice(0, 8);
  const actionKeys = picked.map((a) => `${a.kind}:${a.name}`);
  const actionsText = picked.length ? await actionContext(tenantId, sf, picked) : '';
  // ---- code: automation already in the org (cached); its validation rules tell the planner what values must satisfy ----
  const automation = await orgAutomation(tenantId, sf).catch(() => null);
  const rulesText = automation ? rulesContext(automation, objectNames.slice(0, 3)) : '';

  let usage: Usage = emptyUsage();
  let plan: Plan | undefined;
  let errors: string[] = [];
  let compiled: ReturnType<typeof compilePlan> | undefined;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const fs = primary ? await describeFields(tenantId, sf, primary) : [];
    const ask = attempt === 0
      ? [
          current ? `Current plan:\n${JSON.stringify(current)}\n\nChange requested: ${request}` : `Request: ${request}`,
          `Objects: ${objectNames.join(', ')}`,
          primary ? `Fields of ${primary} (name:type [picklist values]):\n${fieldContext(fs)}` : 'No object detected; pick trigger_object from Objects if the request is about records.',
          actionsText ? `Org actions (key (label) inputs, * = required -> outputs):\n${actionsText}` : '',
          rulesText ? `Validation rules your values must pass (object: error shown when broken):\n${rulesText}` : '',
        ].filter(Boolean).join('\n\n')
      : [
          `Request: ${request}`,
          `Your previous plan:\n${JSON.stringify(plan)}`,
          `It has these problems; return a corrected plan:\n- ${errors.join('\n- ')}`,
          primary ? `Fields of ${primary}:\n${fieldContext(fs)}` : '',
          actionsText ? `Org actions:\n${actionsText}` : '',
        ].filter(Boolean).join('\n\n');

    const r = await llm.complete({ system: PLANNER_SYSTEM, prompt: ask, schema: planSchema(objectNames, fs.map((f) => f.name), actionKeys), model: config.builderModel });
    usage = addUsage(usage, r.usage);
    plan = JSON.parse(r.text) as Plan;
    if (plan.questions.length && !plan.steps.length) { errors = []; compiled = compilePlan(plan); break; }

    // The model may pick another trigger object than we guessed; validate against that object's fields.
    if (plan.trigger_object && plan.trigger_object !== primary) primary = plan.trigger_object;
    compiled = compilePlan(plan);
    errors = [...compiled.errors, ...(await validateAgainstOrg(tenantId, sf, plan, compiled))];
    if (!errors.length) break;
  }

  const p = plan!;
  const c = compiled!;
  let sample: Draft['sample'];
  if (p.trigger_kind === 'record' && p.trigger_object) {
    try {
      const r = await sf.query(`SELECT Id FROM ${p.trigger_object} ORDER BY LastModifiedDate DESC LIMIT 1`);
      const id = (r.records[0] as { Id?: string } | undefined)?.Id;
      if (id) sample = { recordId: id, objectApiName: p.trigger_object };
    } catch { /* no sample, the admin can type a record Id */ }
  }

  // Log the builder's own AI spend like a run, so it shows in usage and counts toward the daily budget.
  await pool.query(
    `insert into runs (tenant_id, input, status, output, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
     values ($1,$2,'done',$3,$4,$5,$6,$7,$8)`,
    [tenantId, JSON.stringify({ builder: request }), `Drafted "${p.name}"`, usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.costUsd],
  );

  return {
    name: p.name || 'New workflow',
    plan: p,
    workflow: { ...c.workflow, meta: { request: current ? request : request, plan: p } },
    summary: c.summary,
    estimateUsd: c.estimateUsd,
    warnings: [...c.warnings, ...(automation ? conflicts(c.workflow, automation) : [])],
    errors,
    questions: p.questions,
    sample,
    builderCostUsd: usage.costUsd,
  };
}

/** Checks that need the org: fields exist and are writable, objects exist, queries actually run. ($0) */
async function validateAgainstOrg(tenantId: string, sf: SalesforceClient, plan: Plan, compiled: ReturnType<typeof compilePlan>): Promise<string[]> {
  const errors: string[] = [];
  const fieldsOf = async (object: string) => {
    try { return new Map((await describeFields(tenantId, sf, object)).map((f) => [f.name, f])); } catch { errors.push(`object ${object} does not exist`); return null; }
  };
  if (plan.trigger_kind === 'record' && plan.trigger_object) {
    const tf = await fieldsOf(plan.trigger_object);
    if (tf) {
      for (const f of compiled.recordFields) if (!tf.has(f)) errors.push(`${plan.trigger_object} has no field ${f}`);
      for (const s of plan.steps.filter((s) => s.action === 'update_record')) {
        for (const f of s.fields) {
          const d = tf.get(f.field);
          if (!d) errors.push(`${plan.trigger_object} has no field ${f.field}`);
          else if (!d.updateable) errors.push(`${plan.trigger_object}.${f.field} cannot be updated`);
        }
      }
    }
  }
  for (const s of plan.steps) {
    if (s.action === 'create_record' && s.object) {
      const of = await fieldsOf(s.object);
      if (of) for (const f of s.fields) {
        const d = of.get(f.field);
        if (!d) errors.push(`${s.object} has no field ${f.field}`);
        else if (d.createable === false) errors.push(`${s.object}.${f.field} cannot be set on create`);
      }
    }
  }
  // Org actions: they exist, input names are real, required inputs are filled.
  for (const [i, s] of plan.steps.entries()) {
    if (s.action !== 'run_action') continue;
    const a = parseActionKey(s.org_action ?? '');
    if (!a) continue; // compile already reported it
    try {
      const d = await describeOrgAction(tenantId, sf, a.kind, a.name);
      const names = new Set(d.inputs.map((x) => x.name));
      for (const f of s.fields) if (!names.has(f.field)) errors.push(`step ${i + 1}: ${s.org_action} has no input ${f.field}; inputs: ${[...names].join(', ') || 'none'}`);
      const given = new Set(s.fields.filter((f) => f.value.trim()).map((f) => f.field));
      for (const x of d.inputs) if (x.required && !given.has(x.name)) errors.push(`step ${i + 1}: ${s.org_action} needs input ${x.name} (${x.type})`);
    } catch { errors.push(`step ${i + 1}: action ${s.org_action} was not found in the org`); }
  }
  // Run every query that has no {{references}} once, with LIMIT 1, to prove it is valid SOQL.
  for (const n of compiled.workflow.nodes.filter((n) => n.type === 'sf.query')) {
    const soql = String(n.config.soql);
    if (soql.includes('{{')) continue;
    try { await sf.query(soql.replace(/LIMIT \d+$/, 'LIMIT 1')); } catch (e) {
      errors.push(`query failed: ${String(e instanceof Error ? e.message : e).replace(/^Salesforce GET \S+ -> /, '').slice(0, 200)}`);
    }
  }
  return errors;
}
