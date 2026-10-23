import type { DescribeField } from '../salesforce/client.js';

// "Follow playbook": the AI finds the procedure in the company's own documents that fits the record and turns its
// steps into concrete changes. Those changes are only a plan: they are checked here against the object's real fields,
// shown to a person in the approval, and carried out by 'Apply planned actions' (rules checked, logged for undo).
// Steps that can't be done in Salesforce automatically (call the customer, check the device) stay as a list for people.

export interface PlannedAction {
  kind: 'update' | 'task';
  /** update: field API name -> new value. */
  fields?: Record<string, string>;
  /** task */
  subject?: string;
  description?: string;
  /** Which step of the procedure this comes from. */
  reason: string;
}

export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    matched: { type: 'boolean', description: 'true only if one of the sections is clearly the procedure for this record' },
    procedure: { type: 'string', description: 'Document title and section of the procedure used, e.g. "Printer guide — Offline printers"' },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['update', 'task'] },
          fields: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, value: { type: 'string' } }, required: ['field', 'value'], additionalProperties: false } },
          subject: { type: 'string' },
          description: { type: 'string' },
          reason: { type: 'string', description: 'The step of the procedure, quoted briefly' },
        },
        required: ['kind', 'fields', 'subject', 'description', 'reason'],
        additionalProperties: false,
      },
    },
    manual_steps: { type: 'array', items: { type: 'string' }, description: 'Steps a person must do (calls, checks); not changes' },
  },
  required: ['matched', 'procedure', 'actions', 'manual_steps'],
  additionalProperties: false,
} as const;

export const PLAN_SYSTEM = `You apply a company's own written procedures to Salesforce records.
You get one record and sections from the company's documents. Decide whether one section is clearly the procedure for this record. If none fits, set matched=false and return no actions.
If one fits, turn ONLY its steps into actions on this record:
- update: set fields of this record (use the exact field API names and allowed values listed).
- task: a follow-up task on this record for a person (subject + description).
Never invent steps the procedure doesn't say. Steps that need a person (calling, checking equipment, judgement) go to manual_steps, unless the procedure says to create a task for them.
Do not repeat a change the record already has.`;

/** Field list for the prompt: what can be changed and to which values. Pure; tested. */
export function fieldGuide(fields: DescribeField[]): string {
  return fields.filter((f) => f.updateable && !/^(Id|OwnerId|RecordTypeId)$/.test(f.name) && f.type !== 'reference').slice(0, 150)
    .map((f) => {
      const vals = (f.picklistValues ?? []).filter((v) => v.active).map((v) => v.value);
      return `${f.name} (${f.label}, ${f.type}${vals.length ? `: ${vals.slice(0, 25).join(' | ')}` : ''})`;
    }).join('\n');
}

/**
 * Keeps only actions Salesforce can take on this record as planned: real updatable fields, allowed picklist values,
 * no-op updates dropped. Everything removed is explained, so the approver sees it. Pure; tested.
 */
export function validatePlan(
  raw: { actions?: { kind?: string; fields?: { field?: string; value?: string }[]; subject?: string; description?: string; reason?: string }[] },
  fields: DescribeField[], record: Record<string, unknown>,
): { actions: PlannedAction[]; dropped: string[] } {
  const byName = new Map(fields.map((f) => [f.name.toLowerCase(), f]));
  const actions: PlannedAction[] = [];
  const dropped: string[] = [];
  for (const a of (raw.actions ?? []).slice(0, 10)) {
    const reason = String(a.reason ?? '').slice(0, 300);
    if (a.kind === 'task') {
      const subject = String(a.subject ?? '').trim().slice(0, 255);
      if (!subject) { dropped.push(`A task without a subject (${reason})`); continue; }
      actions.push({ kind: 'task', subject, description: String(a.description ?? '').slice(0, 4000), reason });
      continue;
    }
    if (a.kind !== 'update') { dropped.push(`Unknown action "${a.kind}" (${reason})`); continue; }
    const set: Record<string, string> = {};
    for (const fv of a.fields ?? []) {
      const f = byName.get(String(fv.field ?? '').toLowerCase());
      const value = String(fv.value ?? '');
      if (!f) { dropped.push(`${fv.field}: no such field (${reason})`); continue; }
      if (!f.updateable || f.type === 'reference' || /^(Id|OwnerId|RecordTypeId)$/.test(f.name)) { dropped.push(`${f.label}: can't be changed by the playbook (${reason})`); continue; }
      const allowed = (f.picklistValues ?? []).filter((v) => v.active).map((v) => v.value);
      if (allowed.length && !allowed.includes(value)) { dropped.push(`${f.label}: "${value}" isn't an allowed value (${reason})`); continue; }
      if (String(record[f.name] ?? '') === value) continue; // already like that
      set[f.name] = value;
    }
    if (Object.keys(set).length) actions.push({ kind: 'update', fields: set, reason });
  }
  return { actions, dropped };
}

/** The plan in words, for the approval and the run log. Pure; tested. */
export function planSummary(procedure: string, actions: PlannedAction[], object: string, manual: string[], dropped: string[]): string {
  const lines: string[] = [];
  if (procedure) lines.push(`Procedure: ${procedure}`);
  for (const a of actions) {
    if (a.kind === 'update') lines.push(`- Update the ${object}: ${Object.entries(a.fields ?? {}).map(([k, v]) => `${k} → ${v}`).join(', ')}  (${a.reason})`);
    else lines.push(`- Create a task: "${a.subject}"  (${a.reason})`);
  }
  if (!actions.length) lines.push('- No changes to make.');
  if (manual.length) lines.push(`For a person to do:\n${manual.slice(0, 8).map((m) => `- ${m}`).join('\n')}`);
  if (dropped.length) lines.push(`Left out:\n${dropped.slice(0, 8).map((d) => `- ${d}`).join('\n')}`);
  return lines.join('\n');
}
