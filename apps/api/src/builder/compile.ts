import type { WFEdge, WFNode, Workflow } from '@crmagents/shared';
import type { Plan, PlanStep } from './plan.js';

// Turns a Plan into a ready-to-run workflow entirely in code: blocks, wiring, {{references}}, approval before
// writes, cheap models where they were shown to be safe, and a plain-English summary with a cost estimate.

const WRITES = new Set(['create_task', 'update_record', 'create_record', 'run_action', 'delete_record', 'attach_file']);
// Rough per-run cost of each AI action (USD), from typical prompt sizes at current prices.
const COST: Record<string, number> = { classify: 0.0003, extract: 0.004, ai_write: 0.01, research: 0.03 };
const KNOWLEDGE_RULES = 'Base the steps on the knowledge sections given and cite them like [1]. If they do not cover the problem, say so in one line and give general guidance. Be concise.';
const CLASSIFY_MODEL = 'claude-haiku-5-5'; // matched Opus on real cases at ~2% of the cost (evals/model-eval.mts)
const READ_TOOLS = ['soql_query', 'get_record', 'describe_object'];

const OP_TEXT: Record<string, string> = {
  equals: 'is', not_equals: 'is not', contains: 'contains', greater_than: 'is above', less_than: 'is below', is_empty: 'is empty', not_empty: 'is not empty',
};

export interface CompileResult {
  workflow: Workflow;
  summary: string[];
  estimateUsd: number;
  /** Problems that make the plan unusable (sent back to the model for one repair). */
  errors: string[];
  /** Things the admin must finish by hand (e.g. a Slack webhook URL). */
  warnings: string[];
  /** Triggering-record fields the workflow reads (checked against the org schema). */
  recordFields: string[];
}

interface StepNode { id: string; action: PlanStep['action']; keys: Set<string> | 'any' }

export function compilePlan(plan: Plan): CompileResult {
  const nodes: WFNode[] = [];
  const edges: WFEdge[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const summary: string[] = [];
  const recordFields = new Set<string>();
  const stepNodes: StepNode[] = [];
  const isRecord = plan.trigger_kind === 'record' && !!plan.trigger_object;
  const counters: Record<string, number> = {};
  const nextId = (prefix: string) => `${prefix}_${(counters[prefix] = (counters[prefix] ?? 0) + 1)}`;

  let x = 0;
  const add = (type: string, config: Record<string, unknown>, label?: string, y = 120): WFNode => {
    const prefix = { 'trigger.salesforce': 'trigger', 'trigger.manual': 'trigger', 'sf.getRecord': 'sf_get', 'logic.branch': 'branch', 'logic.approval': 'approval', 'util.output': 'output', 'ai.classify': 'ai_classify', 'ai.extract': 'ai_extract', 'ai.agent': 'ai_agent', 'sf.query': 'sf_query', 'sf.createTask': 'sf_task', 'sf.updateRecord': 'sf_update', 'sf.createRecord': 'sf_create', 'notify.slack': 'slack', 'sf.action': 'sf_action', 'logic.wait': 'wait', 'knowledge.search': 'kb', 'crm.suggest': 'suggest', 'trigger.webhook': 'trigger', 'trigger.schedule': 'trigger', 'sf.deleteRecord': 'sf_delete', 'sf.readFiles': 'files', 'sf.attachFile': 'attach' }[type] ?? 'node';
    const n: WFNode = { id: nextId(prefix), type, position: { x, y }, config, ...(label ? { label } : {}) };
    if (y === 120) x += 280;
    nodes.push(n);
    return n;
  };
  let prev = { id: '', handle: 'out' };
  // False branches of per-step conditions: they skip their step and rejoin at the next block.
  let rejoin: { id: string; handle: string }[] = [];
  const link = (to: WFNode) => {
    for (const p of [prev, ...rejoin]) {
      if (p.id) edges.push({ id: `${p.id}:${p.handle}->${to.id}`, source: p.id, target: to.id, sourceHandle: p.handle });
    }
    rejoin = [];
    prev = { id: to.id, handle: 'out' };
  };
  const sideOutput = (from: string, handle: string, value: string) => {
    const n: WFNode = { id: nextId('output'), type: 'util.output', position: { x: x, y: 300 }, config: { value } };
    nodes.push(n);
    edges.push({ id: `${from}:${handle}->${n.id}`, source: from, target: n.id, sourceHandle: handle });
  };

  // {record.X} / {stepN.key} / {trigger.input} -> {{...}} references, validated as we go.
  let inLoop = false; // set once a per-record query starts; later steps run once per found record
  const convert = (text: string, upTo: number): string =>
    String(text ?? '').replace(/\{(record|trigger|item|step(\d+))\.([\w.]+)\}/g, (_m, kind: string, n: string | undefined, path: string) => {
      if (kind === 'item') {
        if (!inLoop) { errors.push(`{item.${path}} is only available after a query step with per_record`); return ''; }
        return `{{item.${path}}}`;
      }
      if (kind === 'record') {
        if (!isRecord) { errors.push(`{record.${path}} is used but the workflow is not started by a record`); return ''; }
        recordFields.add(path.split('.')[0]);
        return `{{sf_get_1.record.${path}}}`;
      }
      if (kind === 'trigger') return `{{trigger.${path}}}`;
      const idx = Number(n) - 1;
      const target = stepNodes[idx];
      if (!target || idx >= upTo) { errors.push(`{step${n}.${path}} refers to a step that does not run before step ${upTo + 1}`); return ''; }
      const key = path.split('.')[0];
      if (target.keys !== 'any' && !target.keys.has(key)) {
        errors.push(`step ${n} (${target.action}) has no output "${key}"; it has: ${[...target.keys].join(', ') || 'none'}`);
        return '';
      }
      return target.action === 'extract' ? `{{${target.id}.data.${path}}}` : `{{${target.id}.${path}}}`;
    });
  const convertQuiet = (text: string, upTo: number) => {
    const before = errors.length;
    const out = convert(text, upTo);
    errors.length = before;
    return out;
  };
  const fieldLines = (fields: string[]) => fields.map((f) => { recordFields.add(f); return `${f}: {{sf_get_1.record.${f}}}`; }).join('\n');

  // ---- trigger + record + conditions ----
  const isSchedule = plan.trigger_kind === 'schedule';
  const every = plan.schedule?.every ?? 'day';
  const at = /^\d{1,2}:\d{2}$/.test(plan.schedule?.at ?? '') ? plan.schedule.at : '08:00';
  const event = plan.trigger_event ?? 'created';
  const changed = event === 'created' || event === 'deleted' ? [] : (plan.changed_fields ?? []).filter((f) => /^\w+$/.test(f));
  changed.forEach((f) => recordFields.add(f));
  if (isSchedule) link(add('trigger.schedule', { every, at, tz: 'UTC' }));
  else if (plan.trigger_kind === 'webhook') link(add('trigger.webhook', { recordIdPath: '', objectApiName: '' }));
  else link(add(isRecord ? 'trigger.salesforce' : 'trigger.manual', isRecord ? { objectApiName: plan.trigger_object, event, changedFields: changed.join(', ') } : {}));
  const eventText = event === 'created' ? 'is created' : event === 'updated' ? 'is updated' : event === 'deleted' ? 'is deleted' : 'is created or updated';
  summary.push(isSchedule
    ? `Runs every ${every}${every === 'hour' ? '' : ` at ${at}`}${every === 'week' ? ' on Mondays' : ''} once turned on`
    : plan.trigger_kind === 'webhook' ? 'Runs when another system sends it data (webhook)'
    : isRecord ? `Runs when a ${plan.trigger_object} ${eventText}${changed.length ? ` and ${changed.join(' or ')} changes` : ''}` : 'Runs on demand');
  if (plan.trigger_kind === 'record' && !plan.trigger_object) errors.push('trigger_kind is "record" but no trigger_object is set');

  const needsRecord = isRecord && (plan.conditions.length > 0 || plan.steps.some((s) => s.input_fields.length || /\{record\./.test(JSON.stringify(s))));
  let getNode: WFNode | undefined;
  if (needsRecord) link((getNode = add('sf.getRecord', { sobject: plan.trigger_object, id: '{{trigger.recordId}}', fields: '' }, `Get ${plan.trigger_object}`)));

  for (const c of plan.conditions) {
    if (!isRecord) { errors.push('conditions need a record trigger'); break; }
    recordFields.add(c.field);
    const b = add('logic.branch', { left: `{{sf_get_1.record.${c.field}}}`, operator: c.operator, right: c.value }, `${c.field} ${OP_TEXT[c.operator]} ${c.value}`.trim());
    link(b);
    prev = { id: b.id, handle: 'true' };
    sideOutput(b.id, 'false', `Skipped: only runs when ${c.field} ${OP_TEXT[c.operator]} ${c.value}`.trim() + '.');
    summary.push(`Only if ${c.field} ${OP_TEXT[c.operator]} ${c.value}`.trim());
  }

  // ---- steps ----
  let estimate = 0;
  let approvalAdded = false;
  let skipFrom: { id: string; handle: string } | undefined;
  let loopNode: WFNode | undefined;
  let loopObject = '';
  let result = '';
  plan.steps.forEach((s, i) => {
    if (WRITES.has(s.action) && plan.require_approval && !approvalAdded) {
      approvalAdded = true;
      // The approval message shows real values (case number, category, field values), not placeholders.
      const changes = plan.steps.map((t, j) => (WRITES.has(t.action) ? `- ${changeText(t, plan, (x) => convertQuiet(x, j))}` : '')).filter(Boolean).join('\n');
      const a = add('logic.approval', { message: `Approve these changes?\n${changes}` }, 'Approve changes');
      link(a);
      prev = { id: a.id, handle: 'approved' };
      sideOutput(a.id, 'rejected', 'Not approved: nothing was changed.');
      summary.push('Waits for a person to approve before changing anything');
    }
    if (s.only_if?.value?.trim()) {
      const cond = `${cut(s.only_if.value)} ${OP_TEXT[s.only_if.operator] ?? s.only_if.operator} ${s.only_if.compare}`.trim();
      const b = add('logic.branch', { left: convert(s.only_if.value, i), operator: s.only_if.operator, right: convert(s.only_if.compare, i) }, `If ${cond}`);
      link(b);
      prev = { id: b.id, handle: 'true' };
      skipFrom = { id: b.id, handle: 'false' }; // joins the block after this step, not the step itself
      summary.push(`Next step only if ${cond}:`);
    }
    let node: WFNode;
    let keys: Set<string> | 'any' = new Set();
    switch (s.action) {
      case 'classify':
        if (s.categories.length < 2) errors.push(`step ${i + 1}: classify needs at least two categories`);
        node = add('ai.classify', {
          text: s.input_fields.length ? fieldLines(s.input_fields) : convert(s.instruction, i),
          categories: s.categories.join('\n'),
          instructions: s.input_fields.length ? convert(s.instruction, i) : '',
          model: CLASSIFY_MODEL,
        }, 'Classify');
        keys = new Set(['category', 'reason']);
        result = `Category: {{${node.id}.category}} ({{${node.id}.reason}})`;
        break;
      case 'extract':
        if (!s.outputs.length) errors.push(`step ${i + 1}: extract needs outputs`);
        node = add('ai.extract', {
          text: s.input_fields.length ? fieldLines(s.input_fields) : convert(s.instruction, i),
          fields: s.outputs.map((o) => `${o.name}: ${o.description}`).join('\n'),
        }, 'Extract');
        keys = new Set(s.outputs.map((o) => o.name));
        result = `{{${node.id}.data}}`;
        break;
      case 'ai_write':
      case 'research': {
        const data = s.input_fields.length ? `\n\nData:\n${fieldLines(s.input_fields)}` : '';
        const where = s.action === 'research' && isRecord ? '\n\nRecord: {{trigger.objectApiName}} {{trigger.recordId}}' : '';
        // The AI only sees what the prompt contains: if it doesn't reference earlier data, hand it the latest
        // query's results (or, inside a per-record loop, the current record) so it never works blind.
        let feed = '';
        if (!/\{(step\d+|item)\./.test(s.instruction)) {
          if (inLoop) feed = '\n\nRecord:\n{{item}}';
          else {
            const lastQuery = [...stepNodes.slice(0, i)].reverse().find((x) => x?.action === 'query');
            if (lastQuery) feed = `\n\nRecords found ({{${lastQuery.id}.totalSize}}):\n{{${lastQuery.id}.table}}`;
          }
        }
        // Knowledge found by an earlier step goes in too, unless the instruction already places it.
        const lastKb = [...stepNodes.slice(0, i)].reverse().find((x) => x?.action === 'search_knowledge');
        const kbIdx = lastKb ? stepNodes.indexOf(lastKb) + 1 : 0;
        const lastFiles = [...stepNodes.slice(0, i)].reverse().find((x) => x?.action === 'read_files');
        const filesIdx = lastFiles ? stepNodes.indexOf(lastFiles) + 1 : 0;
        const filesFeed = lastFiles && !new RegExp(`\\{step${filesIdx}\\.`).test(s.instruction) ? `\n\nFiles on the record:\n{{${lastFiles.id}.text}}` : '';
        const kb = lastKb && !new RegExp(`\\{step${kbIdx}\\.`).test(s.instruction) ? `\n\nFrom our knowledge base:\n{{${lastKb.id}.text}}` : '';
        node = add('ai.agent', {
          instructions: lastKb ? `Do exactly what the task asks. ${KNOWLEDGE_RULES}` : 'Do exactly what the task asks. Be concise.',
          prompt: convert(s.instruction, i) + data + feed + filesFeed + kb + where,
          tools: s.action === 'research' ? READ_TOOLS : [],
        }, s.action === 'research' ? 'AI research' : 'AI write');
        keys = new Set(['text']);
        result = `{{${node.id}.text}}`;
        break;
      }
      case 'query': {
        if (!s.object) errors.push(`step ${i + 1}: query needs an object`);
        // Default columns when the plan names none: Id plus the object's usual name field.
        const cols = s.fields.map((f) => f.field).filter(Boolean);
        if (!cols.length) cols.push(...(s.object === 'Case' ? ['Id', 'CaseNumber', 'Subject'] : ['Id', 'Name']));
        if (s.per_record) {
          // The loop needs the record Id, and tasks are assigned to each record's owner.
          if (!cols.includes('Id')) cols.unshift('Id');
          if (plan.steps.slice(i + 1).some((t) => t.action === 'create_task') && !cols.includes('OwnerId')) cols.push('OwnerId');
        }
        const select = cols.join(', ');
        const where = s.where.trim() ? ` WHERE ${convert(s.where, i)}` : '';
        node = add('sf.query', { soql: `SELECT ${select} FROM ${s.object}${where} LIMIT ${s.limit > 0 ? Math.min(s.limit, 200) : 20}` }, `Find ${s.object}`);
        keys = 'any';
        result = `{{${node.id}.totalSize}} ${s.object} record(s):\n{{${node.id}.table}}`;
        break;
      }
      case 'create_task':
        if (!isRecord && !inLoop) warnings.push(`step ${i + 1}: the task is not linked to a record (no record trigger)`);
        node = add('sf.createTask', {
          subject: convert(s.subject || 'Follow up', i),
          // Inside a per-record loop: linked to that record and assigned to its owner.
          relatedTo: inLoop ? '{{item.Id}}' : isRecord ? '{{trigger.recordId}}' : '',
          description: convert(s.message, i),
          ...(inLoop ? { ownerId: '{{item.OwnerId}}' } : {}),
        }, 'Create task');
        keys = new Set(['id']);
        break;
      case 'update_record':
        if (!isRecord && !inLoop) errors.push(`step ${i + 1}: update_record needs a record trigger or a per-record query before it`);
        if (!s.fields.length) errors.push(`step ${i + 1}: update_record needs fields`);
        node = add('sf.updateRecord', {
          sobject: inLoop ? loopObject : plan.trigger_object,
          id: inLoop ? '{{item.Id}}' : '{{trigger.recordId}}',
          fields: JSON.stringify(Object.fromEntries(s.fields.map((f) => [f.field, convert(f.value, i)]))),
        }, `Update ${inLoop ? loopObject : plan.trigger_object}`);
        keys = new Set(['success']);
        break;
      case 'create_record':
        if (!s.object) errors.push(`step ${i + 1}: create_record needs an object`);
        node = add('sf.createRecord', {
          sobject: s.object,
          fields: JSON.stringify(Object.fromEntries(s.fields.map((f) => [f.field, convert(f.value, i)]))),
        }, `Create ${s.object}`);
        keys = new Set(['id']);
        result = result || `Created ${s.object} {{${node.id}.id}}`;
        break;
      case 'run_action':
        if (!/^(apex|flow|standard):[\w.]+$/.test(s.org_action ?? '')) errors.push(`step ${i + 1}: run_action needs org_action from the Org actions list`);
        node = add('sf.action', {
          action: s.org_action ?? '',
          inputs: JSON.stringify(Object.fromEntries(s.fields.map((f) => [f.field, convert(f.value, i)]))),
        }, actionLabel(s.org_action ?? ''));
        keys = 'any';
        result = result || `${actionLabel(s.org_action ?? '')}: done.`;
        break;
      case 'search_knowledge': {
        const q = s.input_fields.length ? s.input_fields.map((f) => { recordFields.add(f); return `{{sf_get_1.record.${f}}}`; }).join(' ') : convert(s.instruction, i);
        if (!q.trim()) errors.push(`step ${i + 1}: search_knowledge needs something to look up (instruction or input_fields)`);
        node = add('knowledge.search', { query: q, limit: 4, docs: '' }, 'Search knowledge');
        keys = new Set(['text', 'sources', 'count']);
        break;
      }
      case 'suggest': {
        if (!isRecord && !inLoop) errors.push(`step ${i + 1}: suggest needs a record trigger or a per-record query before it`);
        const lastAi = [...stepNodes.slice(0, i)].reverse().find((x) => x?.action === 'ai_write' || x?.action === 'research');
        const lastKb = [...stepNodes.slice(0, i)].reverse().find((x) => x?.action === 'search_knowledge');
        const text = convert(s.message || s.instruction, i) || (lastAi ? `{{${lastAi.id}.text}}` : '');
        if (!text) errors.push(`step ${i + 1}: suggest needs a message (usually {stepN.text} of an ai_write)`);
        node = add('crm.suggest', {
          title: convert(s.subject, i) || 'Suggestion',
          text,
          recordId: inLoop ? '{{item.Id}}' : '{{trigger.recordId}}',
          sources: lastKb ? `{{${lastKb.id}.sources}}` : '',
        }, 'Show suggestion');
        keys = new Set(['id', 'text']);
        result = result || text;
        break;
      }
      case 'read_files':
        if (!isRecord && !inLoop) errors.push(`step ${i + 1}: read_files needs a record trigger or a per-record query before it`);
        node = add('sf.readFiles', { recordId: inLoop ? '{{item.Id}}' : '{{trigger.recordId}}', maxFiles: 5 }, 'Read files');
        keys = new Set(['text', 'files']);
        break;
      case 'attach_file': {
        if (!isRecord && !inLoop) errors.push(`step ${i + 1}: attach_file needs a record trigger or a per-record query before it`);
        const lastAi = [...stepNodes.slice(0, i)].reverse().find((x) => x?.action === 'ai_write' || x?.action === 'research');
        const content = convert(s.message, i) || (lastAi ? `{{${lastAi.id}.text}}` : '');
        if (!content) errors.push(`step ${i + 1}: attach_file needs content (usually {stepN.text})`);
        node = add('sf.attachFile', { recordId: inLoop ? '{{item.Id}}' : '{{trigger.recordId}}', title: convert(s.subject, i) || 'CRMagents note', format: 'md', content }, 'Attach file');
        keys = new Set(['id']);
        break;
      }
      case 'delete_record':
        if (!isRecord && !inLoop) errors.push(`step ${i + 1}: delete_record needs a record trigger or a per-record query before it`);
        node = add('sf.deleteRecord', { sobject: inLoop ? loopObject : plan.trigger_object, id: inLoop ? '{{item.Id}}' : '{{trigger.recordId}}' }, `Delete ${inLoop ? loopObject : plan.trigger_object}`);
        keys = new Set(['success']);
        break;
      case 'wait':
        if (inLoop) errors.push(`step ${i + 1}: a wait can't be inside a per-record loop`);
        node = add('logic.wait', { mode: 'For a while', amount: Math.max(1, s.wait_amount ?? 1), unit: s.wait_unit ?? 'days' }, 'Wait');
        keys = new Set(['waitedUntil']);
        break;
      case 'notify_slack':
        node = add('notify.slack', { webhookUrl: '', text: convert(s.message, i) }, 'Slack');
        warnings.push('Paste your Slack webhook URL into the Slack block.');
        keys = new Set(['ok']);
        break;
      default:
        errors.push(`step ${i + 1}: unknown action ${(s as PlanStep).action}`);
        return;
    }
    link(node);
    if (skipFrom) { rejoin.push(skipFrom); skipFrom = undefined; }
    stepNodes[i] = { id: node.id, action: s.action, keys };
    // AI steps inside a loop run once per record: estimate for a typical batch of 10.
    estimate += (COST[s.action] ?? 0) * (inLoop ? 10 : 1);
    summary.push((inLoop ? '  ↳ ' : '') + describe(s, plan));

    if (s.action === 'query' && s.per_record && !inLoop) {
      const later = plan.steps.slice(i + 1);
      if (plan.require_approval && later.some((t) => WRITES.has(t.action)) && !approvalAdded) {
        // One approval for the whole batch, before the loop (approvals can't pause inside a loop).
        approvalAdded = true;
        const changes = later.filter((t) => WRITES.has(t.action)).map((t) => `- ${changeText(t, plan, (x) => x.replace(/\{(?:item|record|step\d+)\.([\w.]+)\}/g, '[$1]'))}`).join('\n');
        const a = add('logic.approval', { message: `For each of the {{${node.id}.totalSize}} ${s.object} records found:\n${changes}\n\nRecords:\n{{${node.id}.table}}` }, 'Approve batch');
        link(a);
        prev = { id: a.id, handle: 'approved' };
        sideOutput(a.id, 'rejected', 'Not approved: nothing was changed.');
        summary.push('Waits for a person to approve the whole batch before changing anything');
      }
      loopNode = add('logic.loop', { items: `{{${node.id}.records}}`, max: s.limit > 0 ? Math.min(s.limit, 100) : 20 }, `For each ${s.object}`);
      link(loopNode);
      prev = { id: loopNode.id, handle: 'each' };
      inLoop = true;
      loopObject = s.object;
      summary.push(`For each ${s.object} found:`);
      result = `Processed {{${loopNode.id}.count}} ${s.object} record(s).`;
    }
  });
  if (loopNode) {
    // The run finishes after every record has been handled.
    prev = { id: loopNode.id, handle: 'done' };
    rejoin = [];
  }

  const done = add('util.output', { value: result || 'Done.' }, 'Result');
  link(done);
  if (getNode) getNode.config.fields = [...recordFields].join(', ');
  if (!plan.steps.length && !plan.questions.length) errors.push('the plan has no steps');

  return {
    workflow: { nodes, edges },
    summary,
    estimateUsd: estimate,
    errors: [...new Set(errors)],
    warnings,
    recordFields: [...recordFields],
  };
}

/** "flow:SvcCopilotTmpl__Close_Case" -> "Runs Flow: Close Case". */
export function actionLabel(key: string): string {
  const [kind, name = ''] = key.split(':');
  const nice = name.replace(/^\w+?__/, '').replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  if (kind === 'standard') return { emailSimple: 'Sends an email', chatterPost: 'Posts to Chatter', submit: 'Submits for approval' }[name] ?? `Runs ${nice}`;
  return `Runs ${kind === 'flow' ? 'Flow' : 'Apex action'}: ${nice || 'action'}`;
}

const cut = (t: string, n = 70) => { const v = pretty(t); return v.length > n ? `${v.slice(0, n - 1)}…` : v; };
const pretty = (t: string) => t.replace(/\{(?:record|trigger|item|step\d+)\.([\w.]+)\}/g, (_m, p: string) => `[${p.split('.').pop()}]`);

/** One line per write for the approval message, with references resolved to real values at run time. */
function changeText(s: PlanStep, plan: Plan, conv: (t: string) => string): string {
  switch (s.action) {
    case 'update_record': return `Update this ${plan.trigger_object}: ${s.fields.map((f) => `${f.field} = ${conv(f.value)}`).join(', ')}`;
    case 'create_task': return `Create Task "${conv(s.subject || 'Follow up')}"`;
    case 'create_record': return `Create ${s.object}: ${s.fields.map((f) => `${f.field} = ${conv(f.value)}`).join(', ')}`;
    case 'run_action': return `${actionLabel(s.org_action ?? '')}${s.fields.length ? `: ${s.fields.map((f) => `${f.field} = ${conv(f.value)}`).join(', ')}` : ''}`;
    case 'delete_record': return `Delete this ${plan.trigger_object}`;
    case 'attach_file': return `Attach file "${conv(s.subject || 'CRMagents note')}" to this ${plan.trigger_object}`;
    default: return s.action;
  }
}

function describe(s: PlanStep, plan: Plan): string {
  switch (s.action) {
    case 'classify': return `AI sorts it into: ${s.categories.join(', ')} (low-cost model)`;
    case 'extract': return `AI pulls out: ${s.outputs.map((o) => o.name).join(', ')}`;
    case 'ai_write': return `AI writes: ${cut(s.instruction)}`;
    case 'research': return `AI looks up related records: ${cut(s.instruction)}`;
    case 'query': return `Finds ${s.object} records (no AI)`;
    case 'create_task': return `Creates a Task: "${cut(s.subject || 'Follow up', 50)}"`;
    case 'update_record': return `Updates the ${plan.trigger_object}: ${s.fields.map((f) => f.field).join(', ')}`;
    case 'create_record': return `Creates a ${s.object}${s.fields.length ? ` (${s.fields.map((f) => f.field).join(', ')})` : ''}`;
    case 'notify_slack': return 'Posts a Slack message';
    case 'run_action': return `${actionLabel(s.org_action ?? '')} (your org's own automation)`;
    case 'wait': return `Waits ${s.wait_amount ?? 1} ${s.wait_unit ?? 'days'}`;
    case 'search_knowledge': return 'Looks up your uploaded guides (no AI)';
    case 'delete_record': return `Deletes the ${plan.trigger_object} (Recycle Bin)`;
    case 'read_files': return 'Reads the files attached to the record (no AI)';
    case 'attach_file': return `Attaches "${cut(s.subject || 'CRMagents note', 40)}" as a file on the record`;
    case 'suggest': return `Shows "${cut(s.subject || 'Suggestion', 40)}" on the record in Salesforce (changes nothing)`;
    default: return s.action;
  }
}
