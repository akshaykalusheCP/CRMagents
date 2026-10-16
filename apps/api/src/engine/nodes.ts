import { parseJsonLoose, type CallOptions, type Effort, type Llm } from '../agent/llm.js';
import { addUsage, type Usage } from '../agent/pricing.js';
import type { Example } from './learn.js';
import type { SalesforceClient } from '../salesforce/client.js';
import type { WFNode } from '@crmagents/shared';
import { recordsToTable } from '../salesforce/table.js';
import { safeFetch } from './net.js';
import { render, renderJson, resolveRaw } from './template.js';

export interface Env {
  sf: SalesforceClient;
  llm: Llm;
  /** Preview mode: AI and reads run for real; writes, messages and approvals are only described. */
  dryRun?: boolean;
  /** Saves progress after each finished step (with the cursor already past it); throws to stop the run. */
  checkpoint?: (st: unknown) => Promise<void>;
  /** Puts real values back in place of personal-data placeholders (only for writes that stay in Salesforce). */
  unmask?: <T>(v: T) => T;
  /** Workspace rules: throws before a write that breaks one. */
  guard?: (ctx: { action: 'update' | 'create' | 'task' | 'email' | 'message' | 'action'; object: string; values?: Record<string, unknown>; recordId?: string; approved?: boolean }) => Promise<void>;
  /** This step was approved by a person (approval rules no longer apply to it). */
  approved?: boolean;
  /** Admin-confirmed examples for a block, most similar first (learning from corrections). */
  examples?: (nodeId: string, text: string) => Promise<Example[]>;
}

export interface NodeResult {
  output: Record<string, any>;
  /** Source handles to follow. Omit to follow all. */
  handles?: string[];
  usage?: Usage;
  /** AI answer reused from an identical earlier request (no tokens spent). */
  reused?: boolean;
  /** Extra detail for the run log (e.g. tool calls). */
  trace?: unknown;
}

export type Executor = (node: WFNode, scope: Record<string, any>, env: Env) => Promise<NodeResult>;

const cfg = (node: WFNode, key: string, scope: Record<string, any>) => render(node.config[key], scope).trim();

const lines = (s: string) => s.split(/\n|,/).map((x) => x.trim()).filter(Boolean);

/** Per-block model/effort overrides; "default" (or unset) keeps the platform defaults. */
function aiOptions(node: WFNode): CallOptions {
  const o: CallOptions = {};
  const model = String(node.config.model ?? 'default');
  const effort = String(node.config.effort ?? 'default');
  if (model !== 'default') o.model = model;
  if (effort === 'low' || effort === 'medium' || effort === 'high') o.effort = effort as Effort;
  return o;
}

const triggerExec: Executor = async (_n, scope) => ({ output: { ...scope.trigger } });

export const EXECUTORS: Record<string, Executor> = {
  'trigger.manual': triggerExec,
  'trigger.salesforce': triggerExec,
  'trigger.schedule': triggerExec,

  async 'ai.agent'(node, scope, env) {
    const prompt = render(node.config.prompt, scope);
    if (!prompt.trim()) throw new Error('Task is empty');
    const r = await env.llm.agent({
      system: render(node.config.instructions, scope) || 'You are a helpful Salesforce assistant.',
      prompt,
      tools: Array.isArray(node.config.tools) ? node.config.tools : [],
      ...aiOptions(node),
    });
    return { output: { text: r.text }, usage: r.usage, trace: r.trace, reused: r.reused };
  },

  async 'ai.classify'(node, scope, env) {
    const categories = [...new Set(lines(render(node.config.categories, scope).replace(/,/g, '\n')))];
    if (categories.length < 2) throw new Error('Add at least two categories');
    const text = render(node.config.text, scope);
    // Past corrections/confirmations for this block, closest first: how this org wants things classified.
    const examples = (await env.examples?.(node.id, text)) ?? [];
    const shown = examples.filter((e) => categories.includes(e.label));
    const learned = shown.length
      ? `\n\nHow this team classified similar items before (follow their judgement):\n${shown.map((e) => `- "${e.input.replace(/\s+/g, ' ').slice(0, 220)}" → ${e.label}`).join('\n')}`
      : '';
    // Structured output: the reply is exactly this JSON, so no tokens go to prose and nothing fails to parse.
    const request = {
      system: `You classify text into exactly one category. ${render(node.config.instructions, scope)}`.trim(),
      prompt: `Categories: ${categories.join(' | ')}${learned}\n\nText:\n"""\n${text}\n"""`,
      schema: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: categories },
          reason: { type: 'string', description: 'One short sentence' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'low or medium when the text is ambiguous or fits several categories' },
        },
        required: ['category', 'reason', 'confidence'],
        additionalProperties: false,
      },
    };
    const opts = aiOptions(node);
    let r = await env.llm.complete({ ...request, ...opts });
    let j = parseJsonLoose(r.text);
    let usage = r.usage;
    let escalated = false;
    // Cheap model first; only uncertain answers go to the platform's default (strongest) model.
    if (opts.model && node.config.escalate === 'when unsure' && j.confidence !== 'high') {
      const strong = await env.llm.complete({ ...request, effort: opts.effort });
      j = parseJsonLoose(strong.text);
      usage = addUsage(usage, strong.usage);
      r = strong;
      escalated = true;
    }
    const category = categories.find((c) => c.toLowerCase() === String(j.category).toLowerCase()) ?? categories[categories.length - 1];
    return {
      output: { category, reason: String(j.reason ?? ''), confidence: String(j.confidence ?? ''), escalated, examplesUsed: shown.length, input: text.slice(0, 2000), categories },
      usage,
      reused: r.reused && !escalated,
    };
  },

  async 'ai.extract'(node, scope, env) {
    const specs = String(node.config.fields ?? '').split('\n').map((x) => x.trim()).filter(Boolean).map((line) => {
      const i = line.indexOf(':');
      return { name: (i < 0 ? line : line.slice(0, i)).trim(), description: i < 0 ? '' : line.slice(i + 1).trim() };
    }).filter((f) => /^[A-Za-z_][\w]*$/.test(f.name));
    if (!specs.length) throw new Error('Add at least one field (one per line: name: description)');
    const r = await env.llm.complete({
      system: 'You extract structured data from text. Use an empty string when a value is not in the text.',
      prompt: `Text:\n"""\n${render(node.config.text, scope)}\n"""`,
      schema: {
        type: 'object',
        properties: Object.fromEntries(specs.map((f) => [f.name, { type: 'string', ...(f.description ? { description: f.description } : {}) }])),
        required: specs.map((f) => f.name),
        additionalProperties: false,
      },
      ...aiOptions(node),
    });
    return { output: { data: parseJsonLoose(r.text) }, usage: r.usage, reused: r.reused };
  },

  async 'sf.query'(node, scope, env) {
    const soql = render(node.config.soql, scope, 'soql').trim();
    if (!/^select\s/i.test(soql)) throw new Error('Only SELECT queries are allowed');
    const r = await env.sf.query(soql);
    // `table` is the token-friendly form for AI prompts; `records` stays for loops and field references.
    return { output: { records: r.records, first: r.records[0] ?? null, totalSize: r.totalSize, table: recordsToTable(r.records) } };
  },

  async 'sf.getRecord'(node, scope, env) {
    const sobject = cfg(node, 'sobject', scope);
    const id = cfg(node, 'id', scope);
    if (!sobject || !id) throw new Error('Object and Record Id are required');
    const fields = cfg(node, 'fields', scope).split(',').map((f) => f.trim()).filter(Boolean);
    return { output: { record: await env.sf.getRecord(sobject, id, fields.length ? fields : undefined) } };
  },

  async 'sf.createRecord'(node, scope, env) {
    const sobject = cfg(node, 'sobject', scope);
    if (!sobject) throw new Error('Object is required');
    const fields = env.unmask ? env.unmask(renderJson(node.config.fields, scope)) : renderJson(node.config.fields, scope);
    await env.guard?.({ approved: env.approved, action: 'create', object: sobject, values: fields });
    if (env.dryRun) return { output: { id: '(preview)', wouldDo: `Create ${sobject}`, fields } };
    const r = await env.sf.createRecord(sobject, fields);
    return { output: { id: r.id } };
  },

  async 'sf.updateRecord'(node, scope, env) {
    const sobject = cfg(node, 'sobject', scope);
    const id = cfg(node, 'id', scope);
    if (!sobject || !id) throw new Error('Object and Record Id are required');
    const fields = env.unmask ? env.unmask(renderJson(node.config.fields, scope)) : renderJson(node.config.fields, scope);
    await env.guard?.({ approved: env.approved, action: 'update', object: sobject, values: fields, recordId: id });
    if (env.dryRun) return { output: { success: true, wouldDo: `Update ${sobject} ${id}`, fields } };
    await env.sf.updateRecord(sobject, id, fields);
    return { output: { success: true } };
  },

  async 'sf.createTask'(node, scope, env) {
    const fields: Record<string, unknown> = {
      Subject: cfg(node, 'subject', scope) || 'Follow up',
      Description: render(node.config.description, scope),
      Status: 'Not Started',
    };
    const rel = cfg(node, 'relatedTo', scope);
    if (rel) {
      // Ids starting 003/00Q are Contact/Lead (WhoId); everything else relates via WhatId.
      if (/^(003|00Q)/.test(rel)) fields.WhoId = rel; else fields.WhatId = rel;
    }
    const owner = cfg(node, 'ownerId', scope);
    if (owner) fields.OwnerId = owner;
    if (env.unmask) Object.assign(fields, env.unmask({ Subject: fields.Subject, Description: fields.Description }));
    await env.guard?.({ approved: env.approved, action: 'task', object: 'Task', values: fields });
    if (env.dryRun) return { output: { id: '(preview)', wouldDo: 'Create Task', fields } };
    return { output: { id: (await env.sf.createRecord('Task', fields)).id } };
  },

  async 'sf.action'(node, scope, env) {
    const key = cfg(node, 'action', scope);
    const m = /^(apex|flow|standard):([\w.]+)$/.exec(key);
    if (!m) throw new Error('Action must look like apex:Name, flow:Name or standard:emailSimple');
    const inputs = env.unmask ? env.unmask(renderJson(node.config.inputs || '{}', scope)) : renderJson(node.config.inputs || '{}', scope);
    await env.guard?.({ approved: env.approved, action: m[2] === 'emailSimple' ? 'email' : m[2] === 'chatterPost' ? 'message' : 'action', object: m[2], values: inputs, recordId: String(inputs.recordId ?? inputs.relatedRecordId ?? '') || undefined });
    // Org actions can change data, send email or call out: in preview they are only described.
    if (env.dryRun) return { output: { success: true, wouldDo: `Run ${m[1] === 'flow' ? 'Flow' : m[1] === 'apex' ? 'Apex action' : 'action'} ${m[2]}`, inputs } };
    const out = await env.sf.runAction(m[1] as 'apex' | 'flow' | 'standard', m[2], inputs);
    return { output: { success: true, ...out } };
  },

  async 'logic.branch'(node, scope) {
    const left = cfg(node, 'left', scope);
    const right = cfg(node, 'right', scope);
    const op = node.config.operator ?? 'equals';
    const num = (s: string) => (s === '' ? NaN : Number(s));
    const result =
      op === 'equals' ? left === right
      : op === 'not_equals' ? left !== right
      : op === 'contains' ? left.toLowerCase().includes(right.toLowerCase())
      : op === 'greater_than' ? num(left) > num(right)
      : op === 'less_than' ? num(left) < num(right)
      : op === 'is_empty' ? left === ''
      : op === 'not_empty' ? left !== ''
      : false;
    return { output: { result }, handles: [result ? 'true' : 'false'] };
  },

  async 'http.request'(node, scope, env) {
    const method = node.config.method ?? 'GET';
    const body = render(node.config.body, scope);
    if (env.dryRun && method !== 'GET') return { output: { status: 0, ok: true, body: null, wouldDo: `${method} ${cfg(node, 'url', scope)}` } };
    const res = await safeFetch(cfg(node, 'url', scope), {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...renderJson(node.config.headers, scope) },
      body: body && method !== 'GET' ? body : undefined,
    });
    const text = await res.text();
    let parsed: unknown = text.slice(0, 20_000);
    try { parsed = JSON.parse(text); } catch { /* keep text */ }
    return { output: { status: res.status, ok: res.ok, body: parsed } };
  },

  async 'notify.slack'(node, scope, env) {
    await env.guard?.({ approved: env.approved, action: 'message', object: 'Slack', values: { text: render(node.config.text, scope) } });
    if (env.dryRun) return { output: { ok: true, wouldDo: 'Post to Slack', text: render(node.config.text, scope) } };
    const url = cfg(node, 'webhookUrl', scope);
    if (!/^https:\/\/hooks\.slack\.com\//.test(url)) throw new Error('Use a hooks.slack.com webhook URL');
    const res = await safeFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: render(node.config.text, scope) }),
    });
    return { output: { ok: res.ok } };
  },

  async 'util.set'(node, scope) {
    return { output: { values: renderJson(node.config.values, scope) } };
  },

  async 'util.output'(node, scope) {
    return { output: { value: render(node.config.value, scope) } };
  },

  // logic.loop and logic.approval are handled by the executor itself.
};

export { resolveRaw };
