import { NODE_DEF_BY_TYPE, WRITE_NODE_TYPES } from '@crmagents/shared';
import { pool } from '../db.js';
import { getSetting } from '../settings.js';
import { SalesforceClient } from './client.js';

// A record of every change agents make, inside Salesforce (CRMagents Agent Activity): which agent, which record,
// what changed, who it acted for and who approved it. Field history shows CRMagents' own user as the editor;
// this says on whose behalf. One API call per run that changed something; can be turned off in Settings.

const MAX_CHANGES = 30_000;

interface StepLike { type: string; label?: string; status: string; output?: Record<string, any>; iteration?: number }

/** One line per change, readable by people. Pure; tested. */
export function changeLines(steps: StepLike[]): string[] {
  const out: string[] = [];
  for (const s of steps) {
    if (!WRITE_NODE_TYPES.includes(s.type) || s.status !== 'ok') continue;
    const o = s.output ?? {};
    if (o.skipped || o.wouldDo || o.approved === false) continue;
    const where = s.iteration !== undefined ? ` (item ${s.iteration + 1})` : '';
    const vals = o.changed && typeof o.changed === 'object' ? `: ${Object.entries(o.changed).map(([k, v]) => `${k} = ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(', ')}` : '';
    const id = o.id && !String(o.id).startsWith('(') ? ` [${o.id}]` : '';
    const name = s.label && s.label !== s.type ? s.label : NODE_DEF_BY_TYPE[s.type]?.label ?? s.type;
    out.push(`${name}${where}${id}${vals}`.slice(0, 1000));
  }
  return out;
}

export async function auditRun(tenantId: string, runId: string): Promise<void> {
  try {
    const { rows } = await pool.query(
      `select r.status, r.input, r.steps, r.started_by, r.decided_by, r.audited, w.name, t.use_package, t.account_id
       from runs r left join workflows w on w.id = r.workflow_id join tenants t on t.id = r.tenant_id where r.id=$1`, [runId]);
    const r = rows[0];
    if (!r || r.audited || !r.use_package || !['done', 'error'].includes(r.status)) return;
    if ((await getSetting(r.account_id, 'auditInSalesforce')) === 'off') return;
    const lines = changeLines((r.steps ?? []) as StepLike[]);
    if (!lines.length) return;
    // Claim it first so a resumed run doesn't write it twice.
    const claimed = await pool.query('update runs set audited=true where id=$1 and not audited returning id', [runId]);
    if (!claimed.rowCount) return;
    const recordId = String(r.input?.recordId ?? '');
    const userId = String(r.input?.sfUserId ?? '');
    const sf = await SalesforceClient.forTenant(tenantId);
    await sf.createRecord('CRMagents_Agent_Activity__c', {
      Run_Id__c: runId,
      Agent__c: String(r.name ?? 'Agent').slice(0, 255),
      Record_Id__c: /^[a-zA-Z0-9]{15,18}$/.test(recordId) ? recordId : null,
      Object__c: String(r.input?.objectApiName ?? '').slice(0, 80) || null,
      On_Behalf_Of__c: /^005[a-zA-Z0-9]{12,15}$/.test(userId) ? userId : null,
      Started_By__c: r.started_by ? String(r.started_by).slice(0, 255) : null,
      Approved_By__c: r.decided_by ? String(r.decided_by).slice(0, 255) : null,
      Status__c: r.status,
      Changes__c: lines.join('\n').slice(0, MAX_CHANGES),
    });
  } catch { /* a convenience: the run itself already finished */ }
}
