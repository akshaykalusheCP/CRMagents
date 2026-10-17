import { USE_CASES, type Workflow } from '@crmagents/shared';
import { addExample } from '../engine/learn.js';
import { pool } from '../db.js';
import { draftWorkflow } from '../builder/service.js';
import { saveVersion } from '../engine/admin.js';
import { previewWorkflow } from '../engine/service.js';
import { SalesforceClient } from '../salesforce/client.js';
import { getAssumptions } from './impact.js';
import { accountOf } from '../tenants.js';

// "What should we automate?" answered from the org's own data, then proven on it.
// Scan: a handful of counting queries (no AI, no record data leaves Salesforce) find repetitive work people do
// by hand: cases re-prioritised manually, customer emails waiting for a reply, leads nobody touched, deals gone
// quiet... Each becomes an opportunity with its volume over the last 30 days and the hours it costs.
// Prove: the builder turns one into an agent (left off), it is replayed on records from the evidence, and what it
// would have set is compared with what the team actually set.

export interface Opportunity {
  id: string;
  title: string;
  area: string;
  evidence: string;
  volume: number;          // per month
  minutesEach: number;
  hoursPerMonth: number;
  valuePerMonth: number;   // at the workspace's hourly rate
  request: string;         // what the builder is asked to build
  sampleSoql?: string;     // records to replay on (record agents)
  decidedSoql?: string;
  teachSoql?: string;
  compareFields?: string[];// fields to compare the agent's choices with the team's
}

interface Detector {
  id: string;              // the use case it maps to
  minutes: number;
  /** Count over the last 30 days, or null when it doesn't apply to this org. */
  count(sf: SalesforceClient): Promise<number | null>;
  evidence(n: number): string;
  sampleSoql?: string;
  /** Records where the team made the choice the agent will make (best for comparing), newest first. */
  decidedSoql?: string;
  /** Records whose current values are the team's choices (when field history isn't tracked). */
  teachSoql?: string;
  compareFields?: string[];
}

const one = async (sf: SalesforceClient, soql: string) => {
  const r = await sf.query(soql);
  const row = r.records[0] as Record<string, unknown> | undefined;
  return Number(row?.n ?? row?.expr0 ?? r.totalSize ?? 0) || 0;
};

const DETECTORS: Detector[] = [
  {
    id: 'case-triage', minutes: 2,
    async count(sf) {
      const byHand = await one(sf, "SELECT COUNT_DISTINCT(CaseId) n FROM CaseHistory WHERE Field IN ('Priority','Type','Reason') AND CreatedDate = LAST_N_DAYS:30 AND CreatedById IN (SELECT Id FROM User WHERE UserType = 'Standard')").catch(() => 0);
      return byHand || (await one(sf, 'SELECT COUNT() FROM Case WHERE CreatedDate = LAST_N_DAYS:30').catch(() => null));
    },
    evidence: (n) => `${n} cases in the last 30 days were sorted by hand (priority or type set by a person)`,
    // Cases with something to judge from (a subject), like the agent will get.
    sampleSoql: 'SELECT Id FROM Case WHERE Subject != null ORDER BY CreatedDate DESC LIMIT 8',
    decidedSoql: "SELECT CaseId FROM CaseHistory WHERE Field IN ('Priority','Type','Reason') AND CreatedById IN (SELECT Id FROM User WHERE UserType = 'Standard') AND Case.Subject != null ORDER BY CreatedDate DESC LIMIT 60",
    teachSoql: 'SELECT Id FROM Case WHERE Subject != null AND (Priority != null OR Type != null) ORDER BY CreatedDate DESC LIMIT 400',
    compareFields: ['Priority', 'Type', 'Reason'],
  },
  {
    id: 'email-replies', minutes: 6,
    count: (sf) => one(sf, 'SELECT COUNT() FROM EmailMessage WHERE Incoming = true AND ParentId != null AND CreatedDate = LAST_N_DAYS:30').catch(() => null),
    evidence: (n) => `${n} customer emails arrived on cases in the last 30 days, each answered by hand`,
    sampleSoql: 'SELECT Id FROM EmailMessage WHERE Incoming = true AND ParentId != null ORDER BY CreatedDate DESC LIMIT 5',
  },
  {
    id: 'waiting-on-customer', minutes: 4,
    count: (sf) => one(sf, "SELECT COUNT() FROM Case WHERE IsClosed = false AND (Status LIKE '%Waiting%' OR Status LIKE '%Hold%' OR Status LIKE '%Pending%') AND LastModifiedDate < LAST_N_DAYS:3").catch(() => null),
    evidence: (n) => `${n} open cases are waiting on the customer with nothing done for 3+ days`,
  },
  {
    id: 'case-close-summary', minutes: 3,
    count: (sf) => one(sf, 'SELECT COUNT() FROM Case WHERE IsClosed = true AND ClosedDate = LAST_N_DAYS:30').catch(() => null),
    evidence: (n) => `${n} cases were closed in the last 30 days, each needing a resolution note`,
    sampleSoql: 'SELECT Id FROM Case WHERE IsClosed = true ORDER BY ClosedDate DESC LIMIT 6',
  },
  {
    id: 'lead-research', minutes: 10,
    count: (sf) => one(sf, 'SELECT COUNT() FROM Lead WHERE CreatedDate = LAST_N_DAYS:30 AND IsConverted = false AND LastActivityDate = null').catch(() => null),
    evidence: (n) => `${n} new leads from the last 30 days have had no call, email or task yet`,
    sampleSoql: 'SELECT Id FROM Lead WHERE IsConverted = false ORDER BY CreatedDate DESC LIMIT 5',
  },
  {
    id: 'lead-routing', minutes: 3,
    count: (sf) => one(sf, "SELECT COUNT() FROM Lead WHERE IsConverted = false AND Owner.Type = 'Queue' AND CreatedDate < YESTERDAY AND CreatedDate = LAST_N_DAYS:30").catch(() => null),
    evidence: (n) => `${n} leads sat in a queue for over a day without an owner`,
  },
  {
    id: 'stale-deals', minutes: 5,
    count: (sf) => one(sf, 'SELECT COUNT() FROM Opportunity WHERE IsClosed = false AND (LastActivityDate < LAST_N_DAYS:14 OR LastActivityDate = null)').catch(() => null),
    evidence: (n) => `${n} open deals have had no activity for 14+ days`,
  },
  {
    id: 'past-close-date', minutes: 2,
    count: (sf) => one(sf, 'SELECT COUNT() FROM Opportunity WHERE IsClosed = false AND CloseDate < TODAY').catch(() => null),
    evidence: (n) => `${n} open deals have a close date in the past, so the forecast is off`,
  },
  {
    id: 'duplicates', minutes: 4,
    async count(sf) {
      const r = await sf.query('SELECT Email, COUNT(Id) c FROM Lead WHERE Email != null AND IsConverted = false GROUP BY Email HAVING COUNT(Id) > 1 LIMIT 500').catch(() => null);
      return r ? (r.records as { c: number }[]).reduce((a, x) => a + Number(x.c) - 1, 0) : null;
    },
    evidence: (n) => `${n} leads are duplicates of another lead with the same email`,
  },
  {
    id: 'fill-missing-data', minutes: 3,
    count: (sf) => one(sf, 'SELECT COUNT() FROM Account WHERE (Industry = null OR Website = null) AND CreatedDate = LAST_N_DAYS:90').catch(() => null),
    evidence: (n) => `${n} accounts from the last 90 days are missing their industry or website`,
    sampleSoql: 'SELECT Id FROM Account WHERE Industry = null OR Website = null ORDER BY CreatedDate DESC LIMIT 5',
  },
];

/** Opportunities ranked by hours per month (zeros dropped). Pure; tested. */
export function rank(found: { id: string; n: number; minutes: number; evidence: string }[], hourlyRate: number): Opportunity[] {
  return found.filter((f) => f.n > 0).map((f) => {
    const uc = USE_CASES.find((u) => u.id === f.id)!;
    const d = DETECTORS.find((x) => x.id === f.id);
    const hours = (f.n * f.minutes) / 60;
    return {
      id: f.id, title: uc.title, area: uc.area, evidence: f.evidence, volume: f.n, minutesEach: f.minutes,
      hoursPerMonth: Math.round(hours * 10) / 10, valuePerMonth: Math.round(hours * hourlyRate), request: uc.request,
      sampleSoql: d?.sampleSoql, decidedSoql: d?.decidedSoql, teachSoql: d?.teachSoql, compareFields: d?.compareFields,
    };
  }).sort((a, b) => b.hoursPerMonth - a.hoursPerMonth);
}

export async function scanOrg(tenantId: string) {
  const sf = await SalesforceClient.forTenant(tenantId);
  const { hourlyRate } = await getAssumptions(await accountOf(tenantId));
  const found = await Promise.all(DETECTORS.map(async (d) => {
    const n = await d.count(sf).catch(() => null);
    return n === null ? null : { id: d.id, n, minutes: d.minutes, evidence: d.evidence(n) };
  }));
  const opportunities = rank(found.filter((x): x is NonNullable<typeof x> => !!x), hourlyRate);
  const result = { opportunities, totalHours: Math.round(opportunities.reduce((a, o) => a + o.hoursPerMonth, 0) * 10) / 10, hourlyRate, checked: DETECTORS.length };
  await pool.query('insert into discoveries (tenant_id, result, scanned_at) values ($1,$2,now()) on conflict (tenant_id) do update set result=$2, scanned_at=now()', [tenantId, JSON.stringify(result)]);
  return { ...result, scannedAt: new Date().toISOString(), builds: await builds(tenantId) };
}

async function builds(tenantId: string) {
  const { rows } = await pool.query(
    `select b.opportunity, b.workflow_id as "workflowId", b.proof, b.created_at as "createdAt", w.name, w.live
     from discovery_builds b left join workflows w on w.id = b.workflow_id where b.tenant_id=$1`, [tenantId]);
  return Object.fromEntries(rows.map((r) => [r.opportunity, r]));
}

export async function lastScan(tenantId: string) {
  const { rows } = await pool.query('select result, scanned_at from discoveries where tenant_id=$1', [tenantId]);
  return rows[0] ? { ...rows[0].result, scannedAt: rows[0].scanned_at, builds: await builds(tenantId) } : null;
}

const norm = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim().toLowerCase());

/** How often the agent chose what the team chose, per field. Pure; tested. */
export function agreement(rows: { recordId: string; proposed: Record<string, unknown> }[], actual: Map<string, Record<string, unknown>>, fields: string[]) {
  let checked = 0, matched = 0;
  const examples: { recordId: string; field: string; agent: string; team: string; same: boolean }[] = [];
  for (const r of rows) {
    const team = actual.get(r.recordId.slice(0, 15));
    if (!team) continue;
    for (const f of fields) {
      if (!(f in r.proposed) || team[f] === undefined || team[f] === null || team[f] === '') continue;
      checked++;
      const same = norm(r.proposed[f]) === norm(team[f]);
      if (same) matched++;
      examples.push({ recordId: r.recordId, field: f, agent: String(r.proposed[f] ?? ''), team: String(team[f]), same });
    }
  }
  return { checked, matched, rate: checked ? matched / checked : null, examples: examples.slice(0, 20) };
}

/** Build the agent for an opportunity (left off), replay it on the evidence, and compare with the team. */
export async function proveOpportunity(tenantId: string, oppId: string, who: string, timezone = 'UTC') {
  const scan = await lastScan(tenantId);
  const opp = (scan?.opportunities as Opportunity[] | undefined)?.find((o) => o.id === oppId);
  if (!opp) throw Object.assign(new Error('Scan the org first.'), { statusCode: 400 });
  const draft = await draftWorkflow(tenantId, opp.request, undefined, timezone);
  if (draft.errors.length || !draft.workflow.nodes.length) throw new Error(`The agent could not be built for this org: ${draft.errors.join('; ') || draft.questions.join(' ')}`);
  const { rows } = await pool.query('insert into workflows (tenant_id, name, graph) values ($1,$2,$3) returning id', [tenantId, draft.name, JSON.stringify(draft.workflow)]);
  const workflowId = rows[0].id as string;
  await saveVersion(workflowId, draft.name, draft.workflow, who);

  const sf = await SalesforceClient.forTenant(tenantId);
  const isRecord = draft.workflow.nodes.some((n) => n.type === 'trigger.salesforce');
  let ids: string[] = [];
  if (isRecord) {
    // Records where a person made the call first (so there is something to compare with), then the most recent ones.
    const q = async (soql?: string) => (soql ? ((await sf.query(soql).catch(() => ({ records: [] }))).records as { Id?: string; CaseId?: string }[]).map((r) => String(r.Id ?? r.CaseId)) : []);
    ids = [...new Set([...(await q(opp.decidedSoql)), ...(await q(opp.sampleSoql))])].slice(0, 8);
  }
  const preview = await previewWorkflow(tenantId, workflowId, 6, isRecord ? (ids.length ? { ids } : {}) : { triggers: [{}], note: `Proof for "${opp.title}" (nothing written)` });

  // The agent's choices vs the team's, on fields both set.
  let agree: ReturnType<typeof agreement> | null = null;
  if (opp.compareFields?.length && preview.object) {
    const proposed = preview.rows.map((r) => ({
      recordId: r.recordId,
      proposed: Object.assign({}, ...r.wouldDo.map((w) => (w.detail && typeof w.detail === 'object' ? w.detail as Record<string, unknown> : {}))),
    }));
    const fields = opp.compareFields.filter((f) => proposed.some((p) => f in p.proposed));
    if (fields.length) {
      const got = await sf.query(`SELECT Id, ${fields.join(', ')} FROM ${preview.object} WHERE Id IN (${proposed.map((p) => `'${p.recordId}'`).join(',')})`).catch(() => ({ records: [] }));
      const actual = new Map((got.records as Record<string, unknown>[]).map((r) => [String(r.Id).slice(0, 15), r]));
      agree = agreement(proposed, actual, fields);
    }
  }
  const proof = {
    workflowId, name: draft.name, summary: draft.summary, estimateUsd: draft.estimateUsd, warnings: draft.warnings,
    replayed: preview.rows.length, ok: preview.rows.filter((r) => r.status === 'done').length,
    rows: preview.rows.slice(0, 8).map((r) => ({ recordId: r.recordId, label: r.label, status: r.status, error: r.error, wouldDo: r.wouldDo.slice(0, 4), decisions: r.decisions.slice(0, 3) })),
    agreement: agree, costUsd: preview.totalCostUsd + draft.builderCostUsd,
    monthlyCostUsd: Math.max(draft.estimateUsd * opp.volume, draft.estimateUsd > 0 ? 0.01 : 0),
    hoursPerMonth: opp.hoursPerMonth, valuePerMonth: opp.valuePerMonth,
  };
  await pool.query(`insert into discovery_builds (tenant_id, opportunity, workflow_id, proof) values ($1,$2,$3,$4)
    on conflict (tenant_id, opportunity) do update set workflow_id=$3, proof=$4, created_at=now()`, [tenantId, oppId, workflowId, JSON.stringify(proof)]);
  return proof;
}

/**
 * Which record field each AI step decides: {{ai_extract_1.data.priority}} written to Priority means the extract
 * step's "priority" is the team's Priority. Pure; tested.
 */
export function fieldSources(graph: Workflow): { field: string; nodeId: string; key: string | null }[] {
  const out: { field: string; nodeId: string; key: string | null }[] = [];
  for (const n of graph.nodes.filter((x) => x.type === 'sf.updateRecord')) {
    let f: Record<string, unknown> = {};
    try { f = typeof n.config.fields === 'string' ? JSON.parse(n.config.fields) : (n.config.fields as Record<string, unknown>) ?? {}; } catch { continue; }
    for (const [field, v] of Object.entries(f)) {
      const m = String(v).match(/^\{\{(\w+)\.(?:data\.(\w+)|category)\}\}$/);
      const src = m && graph.nodes.find((x) => x.id === m[1]);
      if (src && (src.type === 'ai.extract' || src.type === 'ai.classify')) out.push({ field, nodeId: src.id, key: m![2] ?? null });
    }
  }
  return out;
}

/** Turn the team's past decisions into examples for the agent's AI steps, then replay the same records again. */
export async function learnFromTeam(tenantId: string, oppId: string, who: string) {
  const scan = await lastScan(tenantId);
  const opp = (scan?.opportunities as Opportunity[] | undefined)?.find((o) => o.id === oppId);
  const { rows: b } = await pool.query('select workflow_id, proof from discovery_builds where tenant_id=$1 and opportunity=$2', [tenantId, oppId]);
  if (!opp || !b[0]?.workflow_id) throw Object.assign(new Error('Build and replay the agent first.'), { statusCode: 400 });
  const workflowId = b[0].workflow_id as string;
  const proof = b[0].proof as { rows: { recordId: string }[]; agreement: ReturnType<typeof agreement> | null };
  const { rows: w } = await pool.query('select graph from workflows where id=$1', [workflowId]);
  const graph = w[0].graph as Workflow;
  const sources = fieldSources(graph);
  if (!sources.length || !(opp.decidedSoql || opp.teachSoql)) throw new Error('This agent has no AI choice to compare with your team.');
  const sf = await SalesforceClient.forTenant(tenantId);
  const holdout = new Set(proof.rows.map((r) => r.recordId.slice(0, 15)));
  // Past decisions, never the records used for the replay (so the new score is honest).
  const ids = async (soql?: string) => (soql ? ((await sf.query(soql).catch(() => ({ records: [] }))).records as { Id?: string; CaseId?: string }[]).map((r) => String(r.Id ?? r.CaseId)) : []);
  // Hand edits first (field history), then records whose values the team set when creating them.
  const decided = [...new Set([...(await ids(opp.decidedSoql?.replace(/LIMIT \d+/, 'LIMIT 400'))), ...(await ids(opp.teachSoql))])]
    .filter((id) => !holdout.has(id.slice(0, 15))).slice(0, 60);
  if (!decided.length) throw new Error('No past decisions by your team to learn from yet.');
  const object = String(graph.nodes.find((n) => n.type === 'trigger.salesforce')?.config.objectApiName ?? '');
  let learned = 0;
  for (const nodeId of [...new Set(sources.map((s) => s.nodeId))]) {
    const node = graph.nodes.find((n) => n.id === nodeId)!;
    const template = String(node.type === 'ai.extract' ? node.config.text : node.config.text ?? node.config.input ?? '');
    const inputFields = [...template.matchAll(/\{\{\w+\.record\.(\w+)\}\}/g)].map((m) => m[1]);
    const mine = sources.filter((s) => s.nodeId === nodeId);
    const cols = [...new Set(['Id', ...inputFields, ...mine.map((s) => s.field)])].filter((f) => /^\w+$/.test(f));
    const recs = (await sf.query(`SELECT ${cols.join(', ')} FROM ${object} WHERE Id IN (${decided.map((i) => `'${i}'`).join(',')})`)).records as Record<string, unknown>[];
    for (const r of recs) {
      const input = template.replace(/\{\{\w+\.record\.(\w+)\}\}/g, (_m, f) => String(r[f] ?? '')).trim();
      if (!input.replace(/\w+:\s*/g, '').trim()) continue;
      const label = node.type === 'ai.extract'
        ? JSON.stringify(Object.fromEntries(mine.filter((s) => s.key && r[s.field] != null && r[s.field] !== '').map((s) => [s.key, r[s.field]])))
        : String(r[mine[0].field] ?? '');
      if (!label || label === '{}') continue;
      await addExample(tenantId, workflowId, nodeId, input, label, 'confirmed');
      learned++;
    }
  }
  if (!learned) throw new Error('Your team\'s past records had nothing the agent could learn from.');
  // Same records as before, now with the team's examples.
  const preview = await previewWorkflow(tenantId, workflowId, 8, { ids: proof.rows.map((r) => r.recordId), note: `Replay after learning from ${learned} team decisions (nothing written)` });
  const proposed = preview.rows.map((r) => ({ recordId: r.recordId, proposed: Object.assign({}, ...r.wouldDo.map((x) => (x.detail && typeof x.detail === 'object' ? x.detail as Record<string, unknown> : {}))) }));
  const fields = [...new Set(sources.map((s) => s.field))];
  const got = await sf.query(`SELECT Id, ${fields.join(', ')} FROM ${object} WHERE Id IN (${proposed.map((p) => `'${p.recordId}'`).join(',')})`);
  const after = agreement(proposed, new Map((got.records as Record<string, unknown>[]).map((r) => [String(r.Id).slice(0, 15), r])), fields);
  const next = { ...b[0].proof, agreementBefore: proof.agreement, agreement: after, learned, learnedBy: who,
    rows: preview.rows.slice(0, 8).map((r) => ({ recordId: r.recordId, label: r.label, status: r.status, error: r.error, wouldDo: r.wouldDo.slice(0, 4), decisions: r.decisions.slice(0, 3) })),
    costUsd: Number(b[0].proof.costUsd ?? 0) + preview.totalCostUsd };
  await pool.query('update discovery_builds set proof=$3 where tenant_id=$1 and opportunity=$2', [tenantId, oppId, JSON.stringify(next)]);
  return next;
}
