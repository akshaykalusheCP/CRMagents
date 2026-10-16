import type { ActionDescribe, ActionKind, SalesforceClient } from './client.js';

// The org's own automations as building blocks: invocable Apex, autolaunched Flows and a few standard actions.
// Discovered over the REST actions API (no package). Code picks the few that match a request ($0), so the
// planner prompt stays small even in orgs with hundreds of actions.

export interface OrgAction { kind: ActionKind; name: string; label: string }

/** Standard actions worth offering; the rest of the ~150 are product-specific. */
const STANDARD: OrgAction[] = [
  { kind: 'standard', name: 'emailSimple', label: 'Send email' },
  { kind: 'standard', name: 'chatterPost', label: 'Post to Chatter' },
  { kind: 'standard', name: 'submit', label: 'Submit for approval' },
];
/** Inputs the standard actions need in practice (emailSimple alone has 20). */
const STANDARD_INPUTS: Record<string, string[]> = {
  emailSimple: ['emailAddresses', 'emailSubject', 'emailBody', 'recipientId', 'relatedRecordId'],
  chatterPost: ['text', 'subjectNameOrId'],
  submit: ['objectId', 'comment'],
};

const TTL = 30 * 60_000;
const lists = new Map<string, { at: number; actions: OrgAction[] }>();
const details = new Map<string, { at: number; d: ActionDescribe }>();

export const actionKey = (a: { kind: string; name: string }) => `${a.kind}:${a.name}`;

export function parseActionKey(key: string): { kind: ActionKind; name: string } | null {
  const m = /^(apex|flow|standard):([\w.]+)$/.exec(key);
  return m ? { kind: m[1] as ActionKind, name: m[2] } : null;
}

export async function listOrgActions(tenantId: string, sf: SalesforceClient): Promise<OrgAction[]> {
  const hit = lists.get(tenantId);
  if (hit && Date.now() - hit.at < TTL) return hit.actions;
  const [apex, flow] = await Promise.all((['apex', 'flow'] as const).map((k) => sf.listActions(k).catch(() => [])));
  const actions = [
    ...apex.map((a) => ({ kind: 'apex' as const, name: a.name, label: a.label })),
    ...flow.map((a) => ({ kind: 'flow' as const, name: a.name, label: a.label })),
    ...STANDARD,
  ];
  lists.set(tenantId, { at: Date.now(), actions });
  return actions;
}

export async function describeOrgAction(tenantId: string, sf: SalesforceClient, kind: ActionKind, name: string): Promise<ActionDescribe> {
  const k = `${tenantId}|${kind}:${name}`;
  const hit = details.get(k);
  if (hit && Date.now() - hit.at < TTL) return hit.d;
  const d = await sf.describeAction(kind, name);
  if (kind === 'standard' && STANDARD_INPUTS[name]) d.inputs = d.inputs.filter((i) => i.required || STANDARD_INPUTS[name].includes(i.name));
  // Flow bookkeeping outputs are noise for admins and the model.
  d.outputs = d.outputs.filter((o) => !o.name.startsWith('Flow__'));
  details.set(k, { at: Date.now(), d });
  return d;
}

const words = (s: string) => s.toLowerCase().replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^a-z0-9]+/).filter((w) => w.length > 2);

/** Actions whose name/label share words with the request, best first. Pure; tested. */
export function rankActions(request: string, actions: OrgAction[], max = 8): OrgAction[] {
  const want = new Set(words(request).map((w) => w.replace(/s$/, '')));
  const scored = actions.map((a) => {
    const have = new Set(words(`${a.label} ${a.name.replace(/^\w+__/, '')}`).map((w) => w.replace(/s$/, '')));
    let score = 0;
    for (const w of have) if (want.has(w)) score += 1;
    if (/\bmail/.test(request.toLowerCase()) && a.name === 'emailSimple') score += 1; // "mail the customer"
    if (/approv/.test(request.toLowerCase()) && a.name === 'submit') score += 1;
    if (/flow|apex|action/.test(request.toLowerCase()) && a.kind !== 'standard') score += 0.1;
    return { a, score };
  });
  return scored.filter((x) => x.score >= 1).sort((x, y) => y.score - x.score).slice(0, max).map((x) => x.a);
}

/** Compact lines for the planner: "flow:Close_Case (Close Case) inputs: caseId:ID*, reason:STRING -> outputs: success". */
export async function actionContext(tenantId: string, sf: SalesforceClient, picked: OrgAction[]): Promise<string> {
  const out: string[] = [];
  for (const a of picked) {
    try {
      const d = await describeOrgAction(tenantId, sf, a.kind, a.name);
      const ins = d.inputs.slice(0, 10).map((i) => `${i.name}:${i.type}${i.required ? '*' : ''}`).join(', ');
      const outs = d.outputs.slice(0, 8).map((o) => o.name).join(', ');
      out.push(`${actionKey(a)} (${a.label}) inputs: ${ins || 'none'} -> outputs: ${outs || 'none'}`);
    } catch { /* not describable: skip */ }
  }
  return out.join('\n');
}
