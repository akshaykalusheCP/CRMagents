import { NODE_DEF_BY_TYPE, type Workflow } from '@crmagents/shared';
import { config } from '../config.js';
import { pool } from '../db.js';
import { logSpend, setup } from '../insights/ai.js';
import { fields as describeFields } from '../salesforce/schema.js';
import { orgAutomation } from './orgAutomation.js';

// "Why did it fail?" Known failures are explained by code ($0). Anything else goes to the cheap model with the
// failing step, its settings and the object's fields; it returns an explanation and, when it can, a fix to the
// step's settings, which code checks before offering it.

export interface Diagnosis {
  explanation: string;
  /** What the admin should do when there is no automatic fix. */
  action?: 'reconnect' | 'settings' | 'edit' | 'data';
  fix?: { nodeId: string; label: string; changes: Record<string, string>; summary: string };
  costUsd: number;
}

/** Failures we can explain without AI. Pure; tested. */
export function knownFailure(error: string): Omit<Diagnosis, 'costUsd'> | null {
  if (/invalid_grant|expired or revoked|reconnect/i.test(error)) return { explanation: 'The Salesforce login for this org expired or was revoked, so the agent could not reach Salesforce.', action: 'reconnect' };
  if (/budget/i.test(error)) return { explanation: "The workspace's daily AI budget was used up, so AI steps paused until tomorrow.", action: 'settings' };
  if (/API key is not configured|x-api-key|authentication_error/i.test(error)) return { explanation: 'No working AI key is set for this workspace.', action: 'settings' };
  if (/Too many runs|429/.test(error)) return { explanation: 'Too many runs started at once; the rest will run on the next check.', action: 'data' };
  if (/INSUFFICIENT_ACCESS|insufficient access/i.test(error)) return { explanation: 'The connected Salesforce user is not allowed to make this change. Give that user access, or connect with a user who has it.', action: 'data' };
  return null;
}

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['explanation', 'action', 'can_fix', 'changes', 'summary'],
  properties: {
    explanation: { type: 'string', description: 'Max 2 short sentences, plain words, what went wrong' },
    action: { type: 'string', enum: ['edit', 'data', 'settings', 'reconnect'], description: 'edit = the step settings are wrong; data = the record or org data caused it' },
    can_fix: { type: 'boolean', description: 'true only if changing the step settings below fixes it' },
    changes: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['key', 'value'], properties: { key: { type: 'string' }, value: { type: 'string' } } } },
    summary: { type: 'string', description: 'One line describing the fix, e.g. "Set Subject on the new task"' },
  },
};

export async function diagnoseRun(tenantId: string, runId: string): Promise<Diagnosis> {
  const { rows } = await pool.query('select r.output, r.steps, r.status, w.graph from runs r left join workflows w on w.id = r.workflow_id where r.id=$1 and r.tenant_id=$2', [runId, tenantId]);
  if (!rows[0]) throw Object.assign(new Error('run not found'), { statusCode: 404 });
  const steps = (rows[0].steps ?? []) as { nodeId: string; type: string; label: string; status: string; error?: string }[];
  const bad = steps.find((s) => s.status === 'error');
  const error = String(bad?.error ?? rows[0].output ?? '');
  if (!error) throw new Error('This run did not fail.');
  const known = knownFailure(error);
  if (known) return { ...known, costUsd: 0 };

  const graph = rows[0].graph as Workflow | null;
  const node = graph?.nodes.find((n) => n.id === bad?.nodeId);
  const { llm, sf } = await setup(tenantId);
  const object = String(node?.config.sobject ?? (node?.type === 'sf.createTask' ? 'Task' : ''));
  const fieldList = object ? (await describeFields(tenantId, sf, object).catch(() => [])).filter((f) => f.createable !== false || f.updateable).slice(0, 120).map((f) => `${f.name}:${f.type}`).join(', ') : '';
  const rules = object ? (await orgAutomation(tenantId, sf).catch(() => null))?.rules.filter((r) => r.object === object).slice(0, 5).map((r) => r.message).join(' | ') : '';
  const def = node ? NODE_DEF_BY_TYPE[node.type] : undefined;
  const prompt = [
    `Error: ${error.slice(0, 800)}`,
    node ? `Failing step: ${node.label ?? def?.label ?? node.type} (${node.type})\nSettings: ${JSON.stringify(node.config).slice(0, 1500)}\nSetting keys you may change: ${def?.fields.map((f) => f.key).join(', ')}` : 'The failing step is unknown.',
    fieldList ? `Fields of ${object} (name:type):\n${fieldList}` : '',
    rules ? `Validation rules on ${object}: ${rules}` : '',
    'Values may use {{references}} exactly like the existing settings do.',
  ].filter(Boolean).join('\n\n');
  const r = await llm.complete({ system: 'You fix failing Salesforce automation steps. Be brief and concrete. Only propose changes you are confident fix the error.', prompt, schema: SCHEMA, model: config.builderModel });
  if (!r.reused) await logSpend(tenantId, 'diagnose', error.slice(0, 120), r.usage);
  const j = JSON.parse(r.text) as { explanation: string; action: Diagnosis['action']; can_fix: boolean; changes: { key: string; value: string }[]; summary: string };
  const allowed = new Set(def?.fields.map((f) => f.key) ?? []);
  const changes = Object.fromEntries(j.changes.filter((c) => allowed.has(c.key)).map((c) => [c.key, c.value]));
  return {
    explanation: j.explanation,
    action: j.action,
    fix: j.can_fix && node && Object.keys(changes).length ? { nodeId: node.id, label: node.label ?? def?.label ?? node.type, changes, summary: j.summary } : undefined,
    costUsd: r.usage.costUsd,
  };
}

/** Apply a step-settings fix and save the agent. */
export async function applyFix(tenantId: string, workflowId: string, nodeId: string, changes: Record<string, string>) {
  const { rows } = await pool.query('select graph from workflows where id=$1 and tenant_id=$2', [workflowId, tenantId]);
  if (!rows[0]) throw Object.assign(new Error('workflow not found'), { statusCode: 404 });
  const g = rows[0].graph as Workflow;
  const node = g.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error('That step no longer exists in the agent.');
  const allowed = new Set(NODE_DEF_BY_TYPE[node.type]?.fields.map((f) => f.key) ?? []);
  for (const [k, v] of Object.entries(changes)) if (allowed.has(k)) node.config[k] = v;
  await pool.query('update workflows set graph=$3, updated_at=now() where id=$1 and tenant_id=$2', [workflowId, tenantId, JSON.stringify(g)]);
  return { ok: true };
}
