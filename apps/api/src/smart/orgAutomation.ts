import type { Workflow } from '@crmagents/shared';
import type { SalesforceClient } from '../salesforce/client.js';

// What already runs in the org: active record-triggered Flows, Apex triggers and validation rules. Read once and
// cached; used to warn when an agent would work on the same records, and to tell the planner the rules values must meet.

export type SaveEvent = 'created' | 'updated' | 'created or updated' | 'deleted';
export interface OrgAutomation {
  flows: { name: string; label: string; object: string; event: SaveEvent; timing: 'before save' | 'after save' | 'delete' }[];
  triggers: { name: string; object: string }[];
  rules: { name: string; object: string; message: string }[];
}

const TTL = 60 * 60_000;
const cache = new Map<string, { at: number; a: OrgAutomation }>();

const EVENT: Record<string, SaveEvent> = { Create: 'created', Update: 'updated', CreateAndUpdate: 'created or updated', Delete: 'deleted' };

export async function orgAutomation(tenantId: string, sf: SalesforceClient, refresh = false): Promise<OrgAutomation> {
  const hit = cache.get(tenantId);
  if (hit && !refresh && Date.now() - hit.at < TTL) return hit.a;
  const [flows, triggers, rules] = await Promise.all([
    sf.query('SELECT ApiName, Label, TriggerType, RecordTriggerType, TriggerObjectOrEvent.QualifiedApiName FROM FlowDefinitionView WHERE IsActive = true AND TriggerType != null LIMIT 500').catch(() => ({ records: [] })),
    sf.toolingQuery("SELECT Name, TableEnumOrId FROM ApexTrigger WHERE Status = 'Active' LIMIT 1000").catch(() => ({ records: [] })),
    sf.toolingQuery('SELECT ValidationName, EntityDefinition.QualifiedApiName, ErrorMessage FROM ValidationRule WHERE Active = true LIMIT 1000').catch(() => ({ records: [] })),
  ]);
  const a: OrgAutomation = {
    flows: (flows.records as any[]).filter((f) => f.TriggerObjectOrEvent?.QualifiedApiName && /^Record/.test(f.TriggerType ?? '')).map((f) => ({
      name: f.ApiName, label: f.Label, object: f.TriggerObjectOrEvent.QualifiedApiName,
      event: EVENT[f.RecordTriggerType] ?? 'created or updated',
      timing: f.TriggerType === 'RecordBeforeSave' ? 'before save' : f.TriggerType === 'RecordBeforeDelete' ? 'delete' : 'after save',
    })),
    triggers: (triggers.records as any[]).map((t) => ({ name: t.Name, object: t.TableEnumOrId })),
    rules: (rules.records as any[]).filter((r) => r.EntityDefinition?.QualifiedApiName).map((r) => ({ name: r.ValidationName, object: r.EntityDefinition.QualifiedApiName, message: String(r.ErrorMessage ?? '') })),
  };
  cache.set(tenantId, { at: Date.now(), a });
  return a;
}

/** Objects an agent reads as its trigger and objects it writes. Pure. */
export function touched(g: Workflow): { trigger?: { object: string; event: string }; writes: { object: string; kind: 'created' | 'updated' }[] } {
  const t = g.nodes.find((n) => n.type === 'trigger.salesforce');
  const writes: { object: string; kind: 'created' | 'updated' }[] = [];
  for (const n of g.nodes) {
    if (n.type === 'sf.updateRecord' && n.config.sobject) writes.push({ object: String(n.config.sobject), kind: 'updated' });
    if (n.type === 'sf.createRecord' && n.config.sobject) writes.push({ object: String(n.config.sobject), kind: 'created' });
    if (n.type === 'sf.createTask') writes.push({ object: 'Task', kind: 'created' });
  }
  return { trigger: t?.config.objectApiName ? { object: String(t.config.objectApiName), event: String(t.config.event ?? 'created') } : undefined, writes };
}

const fires = (flow: SaveEvent, kind: 'created' | 'updated') => flow === 'created or updated' || flow === kind;

/** Plain-English warnings about automation that already works on the same records. Pure; tested. */
export function conflicts(g: Workflow, a: OrgAutomation): string[] {
  const { trigger, writes } = touched(g);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const w of writes) {
    for (const f of a.flows.filter((f) => f.object === w.object && f.timing !== 'delete' && fires(f.event, w.kind))) {
      const k = `flow:${f.name}:${w.kind}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(`Your Flow "${f.label}" also runs when ${w.object} records are ${w.kind}. Check it doesn't change the same fields as this agent.`);
    }
    const tr = a.triggers.filter((t) => t.object === w.object);
    if (tr.length && !seen.has(`apex:${w.object}`)) {
      seen.add(`apex:${w.object}`);
      out.push(`${tr.length} Apex trigger${tr.length > 1 ? 's' : ''} run when ${w.object} records are saved (${tr.slice(0, 3).map((t) => t.name).join(', ')}${tr.length > 3 ? '…' : ''}).`);
    }
  }
  // An agent that updates the record that triggers it, on updates, can re-trigger itself through other automation.
  if (trigger && /updated/.test(trigger.event) && writes.some((w) => w.object === trigger.object && w.kind === 'updated')) {
    out.push(`This agent runs when a ${trigger.object} is updated and also updates it. Its own changes are skipped, but other automation reacting to them may re-trigger it.`);
  }
  return out;
}

/** Validation rules for the planner, so the values it writes pass them. */
export function rulesContext(a: OrgAutomation, objects: string[], perObject = 5): string {
  return objects.flatMap((o) => a.rules.filter((r) => r.object === o).slice(0, perObject).map((r) => `${o}: ${r.message.slice(0, 140)}`)).join('\n');
}
