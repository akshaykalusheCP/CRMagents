import { validateWorkflow, type Workflow } from '@crmagents/shared';
import { pool } from '../db.js';
import { SalesforceClient } from '../salesforce/client.js';
import { assertBudget } from '../salesforce/limits.js';
import { queueRun, startQueued } from './service.js';
import { triggersOf } from './watcher.js';

// Agent housekeeping: running on records that already exist, version history, and moving agents between orgs.

const MAX_BACKFILL = 2000;
const KEEP_VERSIONS = 50;

/**
 * Runs the agent on existing records (created, or changed, in the last `days`), newest first. Runs are queued and
 * start as the per-minute limit allows. The list of records is read with one query (Bulk API for big objects).
 */
export async function backfill(tenantId: string, workflowId: string, days: number, limit: number, who?: string) {
  const { rows } = await pool.query('select graph from workflows where id=$1 and tenant_id=$2', [workflowId, tenantId]);
  if (!rows[0]) throw Object.assign(new Error('workflow not found'), { statusCode: 404 });
  const trigs = triggersOf(rows[0].graph as Workflow).filter((t) => t.event !== 'deleted');
  if (!trigs.length) throw new Error('Running on existing records works for agents started by a Salesforce record.');
  assertBudget(tenantId, 'background');
  const sf = await SalesforceClient.forTenant(tenantId);
  const since = new Date(Date.now() - Math.max(1, Math.min(days, 3650)) * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const cap = Math.max(1, Math.min(limit, MAX_BACKFILL));
  let queued = 0;
  const per: { object: string; found: number }[] = [];
  for (const t of trigs) {
    const field = t.event === 'created' ? 'CreatedDate' : 'LastModifiedDate';
    const r = await sf.queryAll(`SELECT Id FROM ${t.object} WHERE ${field} >= ${since} ORDER BY ${field} DESC`, cap - queued);
    per.push({ object: t.object, found: r.totalSize });
    for (const rec of r.records as { Id: string }[]) {
      await queueRun(tenantId, workflowId, { recordId: rec.Id, objectApiName: t.object }, who);
      queued++;
    }
    if (queued >= cap) break;
  }
  void startQueued().catch(() => undefined);
  return { queued, objects: per };
}

/** Called on every save: the version list is what "Undo to an earlier version" offers. */
export async function saveVersion(workflowId: string, name: string, graph: unknown, who?: string) {
  await pool.query('insert into workflow_versions (workflow_id, name, graph, saved_by) values ($1,$2,$3,$4)', [workflowId, name, JSON.stringify(graph), who ?? null]);
  await pool.query(
    `delete from workflow_versions where workflow_id=$1 and id not in (select id from workflow_versions where workflow_id=$1 order by created_at desc limit ${KEEP_VERSIONS})`,
    [workflowId]);
}

export async function listVersions(tenantId: string, workflowId: string) {
  const { rows } = await pool.query(
    `select v.id, v.name, v.saved_by as "savedBy", v.created_at as "createdAt", jsonb_array_length(v.graph->'nodes') as steps
     from workflow_versions v join workflows w on w.id = v.workflow_id
     where v.workflow_id=$1 and w.tenant_id=$2 order by v.created_at desc`, [workflowId, tenantId]);
  return rows;
}

export async function restoreVersion(tenantId: string, workflowId: string, versionId: number, who?: string) {
  const { rows } = await pool.query(
    'select v.name, v.graph from workflow_versions v join workflows w on w.id = v.workflow_id where v.id=$1 and v.workflow_id=$2 and w.tenant_id=$3',
    [versionId, workflowId, tenantId]);
  if (!rows[0]) throw Object.assign(new Error('version not found'), { statusCode: 404 });
  await pool.query('update workflows set name=$2, graph=$3, updated_at=now() where id=$1', [workflowId, rows[0].name, JSON.stringify(rows[0].graph)]);
  await saveVersion(workflowId, rows[0].name, rows[0].graph, who);
  return { name: rows[0].name, graph: rows[0].graph };
}

export interface AgentExport { format: 'crmagents-agent@1'; name: string; graph: Workflow; exportedAt: string }

export async function exportAgent(tenantId: string, workflowId: string): Promise<AgentExport> {
  const { rows } = await pool.query('select name, graph from workflows where id=$1 and tenant_id=$2', [workflowId, tenantId]);
  if (!rows[0]) throw Object.assign(new Error('workflow not found'), { statusCode: 404 });
  return { format: 'crmagents-agent@1', name: rows[0].name, graph: rows[0].graph, exportedAt: new Date().toISOString() };
}

/** Objects and fields an agent names (Salesforce steps, triggers, field lists). Pure; tested. */
export function referencedFields(graph: Workflow): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (object: string, fields: string[] = []) => {
    if (!/^\w+$/.test(object)) return;
    const set = out.get(object) ?? new Set<string>();
    for (const f of fields) if (/^\w+$/.test(f)) set.add(f);
    out.set(object, set);
  };
  for (const n of graph.nodes) {
    const c = n.config ?? {};
    if (n.type === 'trigger.salesforce') {
      for (const o of String(c.objectApiName ?? '').split(',').map((x) => x.trim()).filter(Boolean)) add(o, String(c.changedFields ?? '').split(',').map((f) => f.trim()));
    }
    if (['sf.getRecord', 'sf.updateRecord', 'sf.createRecord', 'sf.upsertRecord', 'sf.deleteRecord'].includes(n.type) && !/\{\{/.test(String(c.sobject ?? ''))) {
      const fields = String(c.fields ?? '');
      let names: string[] = [];
      try { names = Object.keys(JSON.parse(fields)); } catch { names = fields.split(',').map((f) => f.trim()); }
      if (n.type === 'sf.upsertRecord' && c.externalIdField) names.push(String(c.externalIdField));
      add(String(c.sobject ?? '').trim(), names);
    }
    if (n.type === 'sf.query') {
      const m = /^\s*select\s+(.+?)\s+from\s+(\w+)/is.exec(String(c.soql ?? ''));
      if (m) add(m[2], m[1].split(',').map((f) => f.trim()).filter((f) => !f.includes('.') && !f.includes('(') && !f.includes('{')));
    }
  }
  return out;
}

/**
 * Adds an exported agent to an org (another org of the workspace, or the same one) as a new agent, turned off.
 * Returns what the target org is missing so the admin can fix it before turning it on.
 */
export async function importAgent(tenantId: string, data: { name: string; graph: Workflow }, who?: string) {
  validateWorkflow(data.graph);
  const sf = await SalesforceClient.forTenant(tenantId);
  const missing: string[] = [];
  for (const [object, fields] of referencedFields(data.graph)) {
    const desc = await sf.describe(object).catch(() => null);
    if (!desc) { missing.push(`Object ${object}`); continue; }
    const have = new Set(desc.map((f) => f.name.toLowerCase()));
    for (const f of fields) if (!have.has(f.toLowerCase())) missing.push(`${object}.${f}`);
  }
  const { rows } = await pool.query('insert into workflows (tenant_id, name, graph) values ($1,$2,$3) returning id', [tenantId, data.name, JSON.stringify(data.graph)]);
  await saveVersion(rows[0].id, data.name, data.graph, who);
  return { id: rows[0].id as string, missing };
}
