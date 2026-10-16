import type { Workflow } from '@crmagents/shared';

// The record that started a run usually arrives with its data already: the polling query can select the fields
// the agent reads, and a "created" change event carries every field that has a value. Handing that data to the
// run saves the "get record" call at the start of every run.

export interface Prefetched {
  /** Fields that were asked for. A field listed here but missing from `record` is empty (null). */
  fields: string[];
  record: Record<string, unknown>;
}

const PLAIN = /^[A-Za-z]\w*$/;
const MAX_FIELDS = 80;

/**
 * Fields the workflow's "get record" step reads from the triggering record, or null when it reads every field
 * (then it still fetches the record itself). Pure; tested.
 */
export function prefetchFields(graph: Workflow, object: string): string[] | null {
  const gets = graph.nodes.filter((n) => n.type === 'sf.getRecord' && String(n.config.id ?? '').trim() === '{{trigger.recordId}}' && String(n.config.sobject ?? '').trim() === object);
  if (!gets.length) return [];
  const out = new Set<string>();
  for (const g of gets) {
    const fields = String(g.config.fields ?? '').split(',').map((f) => f.trim()).filter(Boolean);
    if (!fields.length || fields.some((f) => !PLAIN.test(f))) return null;
    fields.forEach((f) => out.add(f));
  }
  return out.size <= MAX_FIELDS ? [...out] : null;
}

/** The prefetched record when it covers everything the step asks for; otherwise undefined. Pure; tested. */
export function usePrefetched(trigger: Record<string, any> | undefined, sobject: string, id: string, fields: string[]): Record<string, unknown> | undefined {
  const pre = trigger?.prefetched as Prefetched | undefined;
  if (!pre || !fields.length || String(trigger?.recordId ?? '') !== id || String(trigger?.objectApiName ?? '') !== sobject) return undefined;
  const have = new Set(pre.fields.map((f) => f.toLowerCase()));
  if (!fields.every((f) => have.has(f.toLowerCase()))) return undefined;
  // Same shape as the REST record: only the asked fields, empty ones left out.
  const byLower = new Map(Object.entries(pre.record).map(([k, v]) => [k.toLowerCase(), [k, v] as const]));
  const rec: Record<string, unknown> = { Id: id };
  for (const f of fields) {
    const hit = byLower.get(f.toLowerCase());
    if (hit && hit[1] !== null && hit[1] !== undefined && hit[1] !== '') rec[hit[0]] = hit[1];
  }
  return rec;
}

/**
 * From a "created" change event: every field with a value is in the payload, so a missing field is empty.
 * Compound values (names, addresses) come in a different shape than the REST API's, so they disqualify it. Pure; tested.
 */
export function fromCreateEvent(payload: Record<string, unknown>, fields: string[]): Prefetched | null {
  if (!fields.length) return null;
  const record: Record<string, unknown> = {};
  for (const f of fields) {
    const v = payload[f];
    if (v !== null && typeof v === 'object') return null;
    if (v !== undefined && v !== null) record[f] = v;
  }
  return { fields, record };
}
