import { pool } from '../db.js';
import { asText, parseJsonLoose } from '../agent/llm.js';
import { draftWorkflow } from '../builder/service.js';
import { saveVersion } from '../engine/admin.js';
import { logSpend, setup } from '../insights/ai.js';
import { config } from '../config.js';
import { SalesforceClient } from '../salesforce/client.js';

// Automation X-ray: everything that runs when records are saved, per object, and what's wrong with it.
// Read from metadata only (Flow definitions and versions, Apex trigger code, Workflow Rules, validation rules).
// Found in code: two automations writing the same field, crowded objects, retired tools (Process Builder and
// Workflow Rules lost Salesforce support at the end of 2025), clutter (old inactive flows). On request the AI
// explains an object's automation in plain English and drafts one agent that could replace it.

export type Kind = 'flow' | 'process' | 'workflow' | 'trigger';
export type Event = 'created' | 'updated' | 'created or updated' | 'deleted' | 'any';
export interface Automation {
  kind: Kind; name: string; label: string; object: string; event: Event; timing: string; active: boolean;
  managed: boolean; lastModified: string | null; writes: { object: string; fields: string[] }[]; creates: string[];
  steps: number; actions: string[]; order: number | null; outline?: string;
}
export interface Finding { severity: 'high' | 'medium' | 'low'; kind: 'conflict' | 'crowded' | 'legacy' | 'clutter' | 'order'; object: string; title: string; detail: string; automations: string[] }
export interface Xray { automations: Automation[]; findings: Finding[]; objects: { object: string; count: number; kinds: Record<string, number>; rules: number; findings: number }[]; score: number; scannedAt: string; flowsRead: number; flowsSkipped: number }

const MAX_FLOW_READS = 80;
const EVENT: Record<string, Event> = { Create: 'created', Update: 'updated', CreateAndUpdate: 'created or updated', Delete: 'deleted' };
const KIND_LABEL: Record<Kind, string> = { flow: 'Flow', process: 'Process Builder', workflow: 'Workflow Rule', trigger: 'Apex trigger' };

const arr = <T,>(x: T | T[] | undefined | null): T[] => (x == null ? [] : Array.isArray(x) ? x : [x]);

/** What a Flow or Process Builder version does, from its metadata. Pure; tested. */
export function readFlow(md: any, fallbackObject: string): Pick<Automation, 'object' | 'writes' | 'creates' | 'steps' | 'actions' | 'outline'> {
  const pbObject = arr(md?.processMetadataValues).find((v: any) => v?.name === 'ObjectType')?.value?.stringValue;
  const object = md?.start?.object || pbObject || fallbackObject || '';
  // In Process Builder, the triggering record is a variable (myVariable_current); in Flows it's $Record.
  const isTrigger = (ref: string) => !ref || /^\$Record$/.test(ref) || /^myVariable_current$/.test(ref) || /^\$Record\./.test(ref);
  const writes: { object: string; fields: string[] }[] = [];
  for (const u of arr<any>(md?.recordUpdates)) {
    const obj = u.object || (isTrigger(u.inputReference) ? object : '');
    const fields = arr<any>(u.inputAssignments).map((a) => String(a.field)).filter(Boolean);
    if (obj && fields.length) writes.push({ object: obj, fields });
  }
  const creates = arr<any>(md?.recordCreates).map((c) => String(c.object ?? '')).filter(Boolean);
  const actions = arr<any>(md?.actionCalls).map((a) => `${a.actionType ?? 'action'}: ${a.actionName ?? a.name}`);
  const steps = ['assignments', 'decisions', 'recordUpdates', 'recordCreates', 'recordLookups', 'recordDeletes', 'actionCalls', 'loops', 'subflows', 'screens']
    .reduce((n, k) => n + arr(md?.[k]).length, 0);
  // A short outline the AI can explain (entry conditions, decisions, what each update sets).
  const cond = (c: any) => `${c.leftValueReference ?? c.field} ${c.operator} ${JSON.stringify(c.rightValue ?? c.value ?? {}).replace(/[{}"]/g, '').replace(/(stringValue|numberValue|booleanValue|elementReference):/g, '')}`;
  const lines: string[] = [];
  const f = md?.start;
  if (f?.filters || f?.filterFormula) lines.push(`Runs only if: ${f.filterFormula ?? arr<any>(f.filters).map(cond).join(` ${f.filterLogic ?? 'and'} `)}`);
  for (const d of arr<any>(md?.decisions)) lines.push(`Decision "${d.label}": ${arr<any>(d.rules).map((r) => `${r.label} when ${arr<any>(r.conditions).map(cond).join(` ${r.conditionLogic ?? 'and'} `)}`).join('; ')}`.slice(0, 400));
  for (const u of arr<any>(md?.recordUpdates)) lines.push(`Update ${u.object || 'the record'}: ${arr<any>(u.inputAssignments).map((a) => `${a.field} = ${JSON.stringify(a.value ?? {}).replace(/[{}"]/g, '').replace(/(stringValue|numberValue|booleanValue|elementReference):/g, '')}`).join(', ')}`.slice(0, 400));
  for (const c of arr<any>(md?.recordCreates)) lines.push(`Create ${c.object ?? 'a record'}${arr<any>(c.inputAssignments).length ? `: ${arr<any>(c.inputAssignments).map((a) => a.field).join(', ')}` : ''}`.slice(0, 300));
  for (const a of arr<any>(md?.actionCalls)) lines.push(`Action ${a.actionType ?? ''} ${a.actionName ?? a.name}`.trim());
  return { object, writes, creates, steps, actions, outline: lines.join('\n').slice(0, 2500) };
}

/** Fields an Apex trigger appears to set (rec.Field = ...), from its code. Pure; tested. */
export function triggerWrites(body: string): string[] {
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/'(?:\\.|[^'\\])*'/g, "''");
  const out = new Set<string>();
  for (const m of code.matchAll(/\b[a-zA-Z_]\w*\.([A-Za-z]\w*)\s*=(?!=)/g)) {
    if (!/^(size|length|Id|Trigger|new|old|isInsert|isUpdate)$/.test(m[1])) out.add(m[1]);
  }
  return [...out];
}

const overlaps = (a: Event, b: Event) => a === 'any' || b === 'any' || a === b || a === 'created or updated' || b === 'created or updated';

/** Problems found in code (no AI). Pure; tested. */
export function findProblems(list: Automation[], inactiveOld: { name: string; label: string; object: string }[]): Finding[] {
  const out: Finding[] = [];
  const save = list.filter((a) => a.active && a.event !== 'deleted');
  // 1. Two automations writing the same field of the same object on overlapping events.
  const byField = new Map<string, Automation[]>();
  for (const a of save) for (const w of a.writes) for (const f of w.fields) {
    const k = `${w.object}.${f}`;
    byField.set(k, [...(byField.get(k) ?? []), a]);
  }
  for (const [k, as] of byField) {
    const uniq = [...new Map(as.map((a) => [`${a.kind}:${a.name}`, a])).values()];
    if (uniq.length < 2 || !uniq.some((a, i) => uniq.some((b, j) => j > i && overlaps(a.event, b.event)))) continue;
    const [object, field] = k.split('.');
    out.push({ severity: 'high', kind: 'conflict', object, title: `${uniq.length} automations set ${object}.${field}`,
      detail: `${uniq.map((a) => `${KIND_LABEL[a.kind]} "${a.label}"`).join(', ')} all write ${field}. Whichever runs last wins, so the value depends on the order Salesforce runs them in.`,
      automations: uniq.map((a) => a.name) });
  }
  // 2. Crowded objects: many things running on every save.
  const byObject = new Map<string, Automation[]>();
  for (const a of save) byObject.set(a.object, [...(byObject.get(a.object) ?? []), a]);
  for (const [object, as] of byObject) {
    if (as.length >= 4) {
      const kinds = [...new Set(as.map((a) => KIND_LABEL[a.kind]))];
      out.push({ severity: as.length >= 7 ? 'high' : 'medium', kind: 'crowded', object, title: `${as.length} automations run when a ${object} is saved`,
        detail: `${kinds.join(', ')} all react to ${object} saves. Each save runs them all, in an order that is hard to predict${kinds.length > 1 ? ', across different tools' : ''}. Good candidates to combine.`,
        automations: as.map((a) => a.name) });
    }
    const flows = as.filter((a) => a.kind === 'flow' && a.timing === 'after save');
    if (flows.length >= 2 && flows.some((f) => f.order == null)) {
      out.push({ severity: 'low', kind: 'order', object, title: `${flows.length} after-save Flows on ${object} without a set order`,
        detail: 'Without a Trigger Order, Salesforce decides which runs first. Set one in each Flow, or combine them.', automations: flows.map((f) => f.name) });
    }
  }
  // 3. Retired tools.
  for (const a of list.filter((x) => x.active && (x.kind === 'process' || x.kind === 'workflow'))) {
    out.push({ severity: 'medium', kind: 'legacy', object: a.object || '(unknown)', title: `${KIND_LABEL[a.kind]} "${a.label}" is a retired tool`,
      detail: `Salesforce ended support for ${a.kind === 'process' ? 'Process Builder' : 'Workflow Rules'} at the end of 2025: no fixes, and new features don't work with it. Move it to a Flow or an agent.`,
      automations: [a.name] });
  }
  // 4. Clutter.
  for (const f of inactiveOld) {
    out.push({ severity: 'low', kind: 'clutter', object: f.object || '(none)', title: `Inactive Flow "${f.label}" untouched for over a year`,
      detail: 'It never runs. If nobody needs it, delete it so it stops confusing people and searches.', automations: [f.name] });
  }
  const rank = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** 100 = nothing found; each finding costs points by severity. Pure. */
export const healthScore = (f: Finding[]) => Math.max(0, 100 - f.reduce((n, x) => n + (x.severity === 'high' ? 12 : x.severity === 'medium' ? 5 : 1), 0));

export async function scanAutomation(tenantId: string): Promise<Xray> {
  const sf = await SalesforceClient.forTenant(tenantId);
  const [defs, triggers, rules, wfr] = await Promise.all([
    sf.query('SELECT ApiName, Label, ProcessType, TriggerType, RecordTriggerType, TriggerObjectOrEvent.QualifiedApiName, IsActive, LastModifiedDate, ActiveVersionId, LatestVersionId, InstalledPackageName, TriggerOrder FROM FlowDefinitionView LIMIT 2000').catch(() => ({ records: [] })),
    sf.toolingQuery("SELECT Name, TableEnumOrId, NamespacePrefix, UsageBeforeInsert, UsageAfterInsert, UsageBeforeUpdate, UsageAfterUpdate, UsageBeforeDelete, UsageAfterDelete, LastModifiedDate, Body FROM ApexTrigger WHERE Status = 'Active' LIMIT 500").catch(() => ({ records: [] })),
    sf.toolingQuery('SELECT EntityDefinition.QualifiedApiName FROM ValidationRule WHERE Active = true LIMIT 2000').catch(() => ({ records: [] })),
    sf.toolingQuery('SELECT Id, Name, TableEnumOrId, NamespacePrefix, LastModifiedDate FROM WorkflowRule LIMIT 2000').catch(() => ({ records: [] })),
  ]);
  const list: Automation[] = [];
  const saveFlows = (defs.records as any[]).filter((f) => f.IsActive && !f.InstalledPackageName && (f.ProcessType === 'Workflow' || /^Record/.test(f.TriggerType ?? '')));
  let read = 0;
  for (const f of saveFlows) {
    const kind: Kind = f.ProcessType === 'Workflow' ? 'process' : 'flow';
    let info: ReturnType<typeof readFlow> = { object: f.TriggerObjectOrEvent?.QualifiedApiName ?? '', writes: [], creates: [], steps: 0, actions: [] };
    if (read < MAX_FLOW_READS && f.ActiveVersionId) {
      read++;
      const v = await sf.toolingQuery(`SELECT Metadata FROM Flow WHERE Id = '${f.ActiveVersionId}'`).catch(() => null);
      if (v?.records[0]?.Metadata) info = readFlow(v.records[0].Metadata, info.object);
    }
    list.push({
      kind, name: f.ApiName, label: f.Label, object: info.object, active: true, managed: false, lastModified: f.LastModifiedDate ?? null,
      event: kind === 'process' ? 'any' : EVENT[f.RecordTriggerType] ?? 'created or updated',
      timing: kind === 'process' ? 'after save' : f.TriggerType === 'RecordBeforeSave' ? 'before save' : f.TriggerType === 'RecordBeforeDelete' ? 'delete' : 'after save',
      writes: info.writes, creates: info.creates, steps: info.steps, actions: info.actions, order: f.TriggerOrder ?? null, outline: info.outline,
    });
  }
  for (const t of (triggers.records as any[]).filter((x) => !x.NamespacePrefix)) {
    const ins = t.UsageBeforeInsert || t.UsageAfterInsert, upd = t.UsageBeforeUpdate || t.UsageAfterUpdate, del = t.UsageBeforeDelete || t.UsageAfterDelete;
    const fields = triggerWrites(String(t.Body ?? ''));
    list.push({
      kind: 'trigger', name: t.Name, label: t.Name, object: t.TableEnumOrId, active: true, managed: false, lastModified: t.LastModifiedDate ?? null,
      event: ins && upd ? 'created or updated' : ins ? 'created' : upd ? 'updated' : del ? 'deleted' : 'any', timing: t.UsageBeforeInsert || t.UsageBeforeUpdate ? 'before save' : 'after save',
      writes: fields.length ? [{ object: t.TableEnumOrId, fields }] : [], creates: [], steps: String(t.Body ?? '').split('\n').length, actions: [], order: null,
      outline: String(t.Body ?? '').slice(0, 2500),
    });
  }
  for (const w of (wfr.records as any[]).filter((x) => !x.NamespacePrefix)) {
    list.push({ kind: 'workflow', name: w.Name, label: w.Name, object: w.TableEnumOrId, event: 'any', timing: 'after save', active: true, managed: false, lastModified: w.LastModifiedDate ?? null, writes: [], creates: [], steps: 1, actions: [], order: null });
  }
  const yearAgo = Date.now() - 365 * 86_400_000;
  const inactiveOld = (defs.records as any[]).filter((f) => !f.IsActive && !f.InstalledPackageName && f.LastModifiedDate && Date.parse(f.LastModifiedDate) < yearAgo)
    .map((f) => ({ name: f.ApiName, label: f.Label, object: f.TriggerObjectOrEvent?.QualifiedApiName ?? '' }));
  const findings = findProblems(list, inactiveOld);
  const ruleCount = new Map<string, number>();
  for (const r of rules.records as any[]) { const o = r.EntityDefinition?.QualifiedApiName; if (o) ruleCount.set(o, (ruleCount.get(o) ?? 0) + 1); }
  const objects = [...new Set(list.map((a) => a.object).filter(Boolean))].map((object) => {
    const as = list.filter((a) => a.object === object);
    return { object, count: as.length, kinds: as.reduce((m, a) => ({ ...m, [a.kind]: (m[a.kind] ?? 0) + 1 }), {} as Record<string, number>), rules: ruleCount.get(object) ?? 0, findings: findings.filter((f) => f.object === object).length };
  }).sort((a, b) => b.findings - a.findings || b.count - a.count);
  const result: Xray = { automations: list, findings, objects, score: healthScore(findings), scannedAt: new Date().toISOString(), flowsRead: read, flowsSkipped: Math.max(0, saveFlows.length - read) };
  await pool.query('insert into automation_scans (tenant_id, result, scanned_at) values ($1,$2,now()) on conflict (tenant_id) do update set result=$2, scanned_at=now()', [tenantId, JSON.stringify(result)]);
  return result;
}

export async function lastXray(tenantId: string): Promise<Xray | null> {
  const { rows } = await pool.query('select result from automation_scans where tenant_id=$1', [tenantId]);
  return rows[0]?.result ?? null;
}

const EXPLAIN_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'What happens when this object is saved, in plain English, as 3-6 short bullet lines starting with "- ". Business words, not technical ones.' },
    risks: { type: 'string', description: 'Up to 3 short bullet lines about overlaps, conflicts or fragile parts, or an empty string.' },
    replacement: { type: 'string', description: 'One request, as an admin would type it, describing a single agent that does everything these automations do (same conditions, same field values), or an empty string if they should not be combined (e.g. complex Apex).' },
  },
  required: ['summary', 'risks', 'replacement'],
  additionalProperties: false,
};

/** Plain-English explanation of an object's automation, and a request for one agent that could replace it. */
export async function explainObject(tenantId: string, object: string) {
  const x = await lastXray(tenantId);
  if (!x) throw Object.assign(new Error('Run the X-ray first.'), { statusCode: 400 });
  const as = x.automations.filter((a) => a.object === object);
  if (!as.length) throw Object.assign(new Error(`No automation on ${object}.`), { statusCode: 404 });
  const { llm } = await setup(tenantId);
  const prompt = [`Object: ${object}`, ...as.map((a) => `### ${KIND_LABEL[a.kind]} "${a.label}" (${a.event}, ${a.timing})\n${a.outline || (a.writes.length ? `Writes: ${a.writes.map((w) => `${w.object}: ${w.fields.join(', ')}`).join('; ')}` : 'Details not available')}`.slice(0, 2600)),
    `Problems found by code: ${x.findings.filter((f) => f.object === object).map((f) => f.title).join('; ') || 'none'}`].join('\n\n').slice(0, 24_000);
  const r = await llm.complete({ system: 'You explain Salesforce automation to business admins in plain English. Be concrete and short. Never invent behavior that is not in the description.', prompt, schema: EXPLAIN_SCHEMA, model: config.builderModel });
  if (!r.reused) await logSpend(tenantId, 'automation x-ray', object, r.usage);
  const raw = parseJsonLoose(r.text);
  const j = { summary: asText(raw.summary), risks: asText(raw.risks), replacement: asText(raw.replacement) };
  return { object, ...j, costUsd: r.reused ? 0 : r.usage.costUsd };
}

/** Draft one agent (left off) that would do what an object's automations do. */
export async function draftReplacement(tenantId: string, request: string, who: string, timezone = 'UTC') {
  const draft = await draftWorkflow(tenantId, request, undefined, timezone);
  if (draft.errors.length || !draft.workflow.nodes.length) throw new Error(`Could not build it: ${draft.errors.join('; ') || draft.questions.join(' ')}`);
  const { rows } = await pool.query('insert into workflows (tenant_id, name, graph) values ($1,$2,$3) returning id', [tenantId, draft.name, JSON.stringify(draft.workflow)]);
  await saveVersion(rows[0].id, draft.name, draft.workflow, who);
  return { workflowId: rows[0].id as string, name: draft.name, summary: draft.summary, warnings: draft.warnings, costUsd: draft.builderCostUsd };
}
