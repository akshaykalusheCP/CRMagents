import { findOwners, freeTimes } from '../salesforce/meetings.js';
import { IMAGE_PROMPT } from '../knowledge/ocr.js';
import type { ImageInput } from '../agent/images.js';
import { sendText } from '../channels/twilio.js';
import { accountOf } from '../tenants.js';
import { parseJsonLoose, type CallOptions, type Effort, type Llm } from '../agent/llm.js';
import { addUsage, emptyUsage, type Usage } from '../agent/pricing.js';
import type { Example } from './learn.js';
import type { SalesforceClient, SaveOp } from '../salesforce/client.js';
import type { WFNode } from '@crmagents/shared';
import { recordsToTable } from '../salesforce/table.js';
import { safeFetch } from './net.js';
import { render, renderJson, resolveRaw } from './template.js';
import { hitSources, hitsToText, searchKnowledge } from '../knowledge/store.js';
import { saveSuggestion } from '../knowledge/suggestions.js';
import { usePrefetched } from './prefetch.js';
import { fileNameFor, recordFilesText } from '../salesforce/files.js';
import { emailThread, sendCaseReply } from '../salesforce/email.js';

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
  guard?: (ctx: { action: 'update' | 'create' | 'delete' | 'task' | 'email' | 'message' | 'action'; object: string; values?: Record<string, unknown>; recordId?: string; approved?: boolean }) => Promise<void>;
  /** This step was approved by a person (approval rules no longer apply to it). */
  approved?: boolean;
  /** Admin-confirmed examples for a block, most similar first (learning from corrections). */
  examples?: (nodeId: string, text: string) => Promise<Example[]>;
  /** Inside a loop: writes collected here and sent together when the loop ends (sObject Collections). */
  writes?: WriteBuffer;
  /** Team memory and the notes agents kept on a record, for AI steps (empty when memory is off). */
  memory?: (question: string, recordId?: string) => Promise<string>;
  /** The run this step belongs to (absent in previews). */
  run?: { tenantId: string; runId: string; workflowId?: string };
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

/** Writes queued during a loop. `defer` lists the steps whose output nothing else reads, so they can wait. */
export interface WriteBuffer {
  defer: Set<string>;
  ops: (SaveOp & { label: string; item: number })[];
  item: number;
}

/** Queues a write when the loop batches it; returns false when it must run now. */
function queued(env: Env, node: WFNode, op: SaveOp): boolean {
  if (!env.writes || env.dryRun || !env.writes.defer.has(node.id)) return false;
  env.writes.ops.push({ ...op, label: node.label || node.type, item: env.writes.item });
  return true;
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
    // Memory: the team's definitions and what agents noted on this record before; and it may leave a note for next time.
    const recordId = String(scope.trigger?.recordId ?? '');
    const remembered = (await env.memory?.(prompt, recordId || undefined)) ?? '';
    const baseTools = Array.isArray(node.config.tools) ? node.config.tools : [];
    const r = await env.llm.agent({
      system: [render(node.config.instructions, scope) || 'You are a helpful Salesforce assistant.', remembered,
        remembered && recordId ? 'If you learn a lasting fact about this record that will matter next time, call remember_about_record. Never personal data.' : ''].filter(Boolean).join('\n\n'),
      prompt,
      tools: remembered && recordId ? [...new Set([...baseTools, 'remember_about_record'])] : baseTools,
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
    const text = render(node.config.text, scope);
    // Decisions the team made on similar records (learned from their history), as worked examples.
    const examples = ((await env.examples?.(node.id, text)) ?? []).filter((e) => e.label.startsWith('{'));
    const shown = examples.length
      ? `How this team decided on similar records (follow their judgement):\n${examples.map((e) => `- ${e.input.replace(/\s+/g, ' ').slice(0, 300)} → ${e.label}`).join('\n')}\n\n`
      : '';
    const r = await env.llm.complete({
      system: 'You extract structured data from text. Use an empty string when a value is not in the text.',
      prompt: `${shown}Text:\n"""\n${text}\n"""`,
      schema: {
        type: 'object',
        properties: Object.fromEntries(specs.map((f) => [f.name, { type: 'string', ...(f.description ? { description: f.description } : {}) }])),
        required: specs.map((f) => f.name),
        additionalProperties: false,
      },
      ...aiOptions(node),
    });
    const got = parseJsonLoose(r.text);
    const data = Object.fromEntries(specs.map((f) => [f.name, got?.[f.name] == null ? '' : got[f.name]]));
    return { output: { data, examplesUsed: examples.length }, usage: r.usage, reused: r.reused };
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
    // The triggering record often arrived with its data (polling query or change event): no API call needed.
    const pre = usePrefetched(scope.trigger, sobject, id, fields);
    if (pre) return { output: { record: pre, prefetched: true } };
    // A deleted record is only in the Recycle Bin: read it with an ALL ROWS query.
    if (scope.trigger?.deleted && String(scope.trigger.recordId) === id) {
      const cols = fields.length ? fields.filter((f) => /^\w+$/.test(f)).join(', ') : 'FIELDS(STANDARD)';
      const r = await env.sf.queryWithDeleted(`SELECT ${cols} FROM ${sobject.replace(/\W/g, '')} WHERE Id = '${id.replace(/\W/g, '')}' LIMIT 1`);
      if (!r.records[0]) throw new Error('The deleted record is no longer in the Recycle Bin');
      return { output: { record: r.records[0], deleted: true } };
    }
    return { output: { record: await env.sf.getRecord(sobject, id, fields.length ? fields : undefined) } };
  },

  async 'sf.createRecord'(node, scope, env) {
    const sobject = cfg(node, 'sobject', scope);
    if (!sobject) throw new Error('Object is required');
    const fields = env.unmask ? env.unmask(renderJson(node.config.fields, scope)) : renderJson(node.config.fields, scope);
    await env.guard?.({ approved: env.approved, action: 'create', object: sobject, values: fields });
    if (env.dryRun) return { output: { id: '(preview)', wouldDo: `Create ${sobject}`, fields } };
    if (queued(env, node, { kind: 'create', sobject, fields })) return { output: { id: '(saved with the batch)', queued: true, changed: fields } };
    const r = await env.sf.createRecord(sobject, fields);
    return { output: { id: r.id, changed: fields } };
  },

  async 'sf.updateRecord'(node, scope, env) {
    const sobject = cfg(node, 'sobject', scope);
    const id = cfg(node, 'id', scope);
    if (!sobject || !id) throw new Error('Object and Record Id are required');
    const fields = env.unmask ? env.unmask(renderJson(node.config.fields, scope)) : renderJson(node.config.fields, scope);
    await env.guard?.({ approved: env.approved, action: 'update', object: sobject, values: fields, recordId: id });
    if (env.dryRun) return { output: { success: true, wouldDo: `Update ${sobject} ${id}`, fields } };
    if (queued(env, node, { kind: 'update', sobject, id, fields })) return { output: { success: true, queued: true, changed: fields } };
    await env.sf.updateRecord(sobject, id, fields);
    return { output: { success: true, changed: fields } };
  },

  async 'sf.deleteRecord'(node, scope, env) {
    const sobject = cfg(node, 'sobject', scope);
    const id = cfg(node, 'id', scope);
    if (!sobject || !id) throw new Error('Object and Record Id are required');
    await env.guard?.({ approved: env.approved, action: 'delete', object: sobject, recordId: id });
    if (env.dryRun) return { output: { success: true, wouldDo: `Delete ${sobject} ${id} (to the Recycle Bin)` } };
    if (queued(env, node, { kind: 'delete', sobject, id, fields: {} })) return { output: { success: true, queued: true } };
    await env.sf.deleteRecord(sobject, id);
    return { output: { success: true } };
  },

  // Create or update by an external Id (e.g. an order number from another system): one call, no lookup first.
  async 'sf.upsertRecord'(node, scope, env) {
    const sobject = cfg(node, 'sobject', scope);
    const field = cfg(node, 'externalIdField', scope);
    const value = cfg(node, 'externalId', scope);
    if (!sobject || !field || !value) throw new Error('Object, external Id field and value are required');
    const fields = env.unmask ? env.unmask(renderJson(node.config.fields, scope)) : renderJson(node.config.fields, scope);
    await env.guard?.({ approved: env.approved, action: 'update', object: sobject, values: fields });
    if (env.dryRun) return { output: { id: '(preview)', created: false, wouldDo: `Create or update ${sobject} where ${field} = ${value}`, fields } };
    return { output: await env.sf.upsertRecord(sobject, field, value, fields) };
  },

  async 'sf.emailThread'(node, scope, env) {
    const recordId = cfg(node, 'recordId', scope) || String(scope.trigger?.recordId ?? '');
    if (!recordId) throw new Error('Which case?');
    return { output: await emailThread(env.sf, recordId, Number(node.config.max) || 15) };
  },

  // Free times on Salesforce users' calendars, to offer in an email ("Would one of these work?"). Reads only.
  async 'sf.meetingTimes'(node, scope, env) {
    const who = cfg(node, 'users', scope).split(/[\s,;]+/).filter(Boolean);
    if (!who.length) throw new Error('Whose calendar? Give an email or user Id, e.g. {{trigger.record.OwnerId}}');
    const owners = await findOwners(env.sf, who);
    const slots = await freeTimes(env.sf, owners, { days: Number(node.config.days) || 7, durationMin: Number(node.config.duration) || 30, max: Number(node.config.count) || 3 });
    return { output: { slots, count: slots.length, text: slots.length ? slots.map((x) => `- ${x.label}`).join('\n') : 'No free times in the next days.' } };
  },

  // Reply to the customer's email on a case. "suggest": a person checks it and clicks Send on the case;
  // "send": it goes out now (an approval step or "ask first" can stand in front of it).
  async 'sf.emailReply'(node, scope, env) {
    const recordId = cfg(node, 'recordId', scope) || String(scope.trigger?.recordId ?? '');
    let body = render(node.config.body, scope).trim();
    if (!recordId || !body) throw new Error('A case and the reply text are needed');
    if (env.unmask) body = env.unmask(body);
    // Started by an email we sent (our own reply, a person's reply)? Never answer it: that would loop.
    if (recordId.startsWith('02s')) {
      const e = await env.sf.query(`SELECT Incoming FROM EmailMessage WHERE Id = '${recordId.replace(/\W/g, '')}'`);
      if ((e.records[0] as { Incoming?: boolean } | undefined)?.Incoming === false) return { output: { sent: false, skipped: 'Not a customer email: nothing to answer' } };
    }
    const t = await emailThread(env.sf, recordId, 3);
    const to = cfg(node, 'to', scope) || t.lastFrom;
    const subject = cfg(node, 'subject', scope) || (t.lastSubject ? (/^re:/i.test(t.lastSubject) ? t.lastSubject : `Re: ${t.lastSubject}`) : '');
    const mode = node.config.mode === 'send' ? 'send' : 'suggest';
    if (mode === 'send') {
      await env.guard?.({ approved: env.approved, action: 'email', object: 'Case', values: { to, subject }, recordId: t.caseId });
      if (env.dryRun) return { output: { sent: false, wouldDo: `Email ${to || 'the customer'}: ${subject}`, text: body } };
      await sendCaseReply(env.sf, { caseId: t.caseId, to, subject, body, inReplyToId: t.lastEmailId });
      return { output: { sent: true, to, subject, text: body } };
    }
    if (env.dryRun || !env.run) return { output: { sent: false, wouldDo: `Suggest a reply to ${to || 'the customer'} on the case`, text: body } };
    const id = await saveSuggestion(env.run.tenantId, {
      recordId: t.caseId, objectName: 'Case', title: cfg(node, 'title', scope) || 'Suggested reply', body,
      workflowId: env.run.workflowId, runId: env.run.runId, kind: 'email_reply', meta: { to, subject, inReplyToId: t.lastEmailId },
    });
    return { output: { sent: false, suggestionId: id, to, subject, text: body } };
  },

  async 'sf.readFiles'(node, scope, env) {
    const recordId = cfg(node, 'recordId', scope) || String(scope.trigger?.recordId ?? '');
    if (!recordId) throw new Error('Which record\'s files?');
    // Images on the record are looked at by the AI (what they show and the text in them); that part costs AI.
    let usage = emptyUsage();
    const describe = async (img: ImageInput) => {
      const r = await env.llm.complete({ system: 'You read images attached to business records.', prompt: IMAGE_PROMPT, images: [img], ...aiOptions(node) });
      usage = addUsage(usage, r.usage);
      return r.text;
    };
    const output = await recordFilesText(env.sf, recordId, Number(node.config.maxFiles) || 5, Number(node.config.maxChars) || 30_000, describe);
    return { output, usage };
  },

  async 'sf.attachFile'(node, scope, env) {
    const recordId = cfg(node, 'recordId', scope) || String(scope.trigger?.recordId ?? '');
    const title = cfg(node, 'title', scope) || 'Nimbus note';
    let content = render(node.config.content, scope);
    if (env.unmask) content = env.unmask(content);
    if (!recordId || !content.trim()) throw new Error('A record and some content are needed');
    const fileName = fileNameFor(title, String(node.config.format ?? 'md'));
    await env.guard?.({ approved: env.approved, action: 'create', object: 'ContentVersion', values: { Title: title }, recordId });
    if (env.dryRun) return { output: { id: '(preview)', wouldDo: `Attach "${fileName}" to ${recordId}` } };
    const r = await env.sf.attachFile(recordId, title, fileName, Buffer.from(content, 'utf8'));
    return { output: { id: r.versionId } };
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
    if (queued(env, node, { kind: 'create', sobject: 'Task', fields })) return { output: { id: '(saved with the batch)', queued: true } };
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

  // A text message (SMS or WhatsApp) from the workspace's Twilio number.
  async 'notify.sms'(node, scope, env) {
    const to = cfg(node, 'to', scope);
    let body = render(node.config.text, scope).trim();
    const channel = node.config.channel === 'whatsapp' ? 'whatsapp' : 'sms';
    if (!to || !body) throw new Error('A phone number and the message are needed');
    if (env.unmask) body = env.unmask(body);
    await env.guard?.({ approved: env.approved, action: 'message', object: channel === 'whatsapp' ? 'WhatsApp' : 'SMS', values: { to, text: body } });
    if (env.dryRun) return { output: { sent: false, wouldDo: `Text ${to} (${channel})`, text: body } };
    const tenantId = env.run?.tenantId;
    if (!tenantId) throw new Error('No workspace for this run');
    const r = await sendText(await accountOf(tenantId), { to, body, channel });
    return { output: { sent: true, to, sid: r.sid } };
  },

  async 'knowledge.search'(node, scope, env) {
    const query = cfg(node, 'query', scope);
    if (!query) throw new Error('Say what to look up');
    const docs = lines(cfg(node, 'docs', scope));
    const hits = await searchKnowledge(env.sf.accountId, query, Number(node.config.limit) || 4, docs);
    return { output: { text: hitsToText(hits), sources: hitSources(hits), count: hits.length } };
  },

  // Saves advice against a record, shown on that record's page in Salesforce. Not a Salesforce write.
  async 'crm.suggest'(node, scope, env) {
    const recordId = cfg(node, 'recordId', scope) || String(scope.trigger?.recordId ?? '');
    if (!/^[a-zA-Z0-9]{15,18}$/.test(recordId)) throw new Error('No record to attach the suggestion to');
    let body = render(node.config.text, scope).trim();
    if (!body) throw new Error('The suggestion is empty');
    if (env.unmask) body = env.unmask(body);
    const raw = node.config.sources ? resolveRaw(node.config.sources, scope) : [];
    const sources = Array.isArray(raw) ? raw : [];
    const title = cfg(node, 'title', scope) || 'Suggestion';
    if (env.dryRun || !env.run) return { output: { id: '(preview)', wouldDo: `Show a suggestion on record ${recordId}`, title, text: body } };
    const id = await saveSuggestion(env.run.tenantId, {
      recordId, objectName: String(scope.trigger?.objectApiName ?? node.config.objectName ?? ''), title, body, sources,
      workflowId: env.run.workflowId, runId: env.run.runId,
    });
    return { output: { id, text: body } };
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
