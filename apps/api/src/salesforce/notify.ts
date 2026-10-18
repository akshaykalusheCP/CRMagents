import { allowed, apiLevel } from './limits.js';
import { config } from '../config.js';
import { pool } from '../db.js';
import { SalesforceClient } from './client.js';

// Telling Salesforce what happened, so people see it where they work:
// - a Platform Event when a run changes state (the Nimbus panel listens and updates live), package orgs only;
// - a bell notification to the approver when a run needs a decision (works without the package).

export const NOTIFICATION_TYPE = 'CRMagents_Approval';
const typeIds = new Map<string, string>();

/** Create the custom notification type once per org (Tooling API); remembered after the first lookup. */
export async function ensureNotificationType(tenantId: string, sf: SalesforceClient): Promise<string | null> {
  const hit = typeIds.get(tenantId);
  if (hit) return hit;
  const find = async () => (await sf.query(`SELECT Id FROM CustomNotificationType WHERE DeveloperName = '${NOTIFICATION_TYPE}' LIMIT 1`)).records[0] as { Id: string } | undefined;
  let row = await find();
  if (!row) {
    await sf.tooling('POST', '/sobjects/CustomNotificationType', {
      DeveloperName: NOTIFICATION_TYPE, MasterLabel: 'Nimbus approval', CustomNotifTypeName: 'Nimbus approval',
      Description: 'An agent is waiting for someone to approve a change.', Desktop: true, Mobile: true, Language: 'en_US',
    });
    row = await find();
  }
  if (row) typeIds.set(tenantId, row.Id);
  return row?.Id ?? null;
}

/** Salesforce user to notify for an approval: the assignee by email, else the record owner, else the connecting user. */
// Lookups that rarely change are kept for a while, so repeated approvals don't cost an API call each.
const userIds = new Map<string, { id: string | null; at: number }>();
const USER_TTL = 60 * 60_000;

async function approverUserId(sf: SalesforceClient, tenantId: string, assignedTo: string | null, recordId?: string, objectApiName?: string, ownerId?: string): Promise<string[]> {
  if (assignedTo) {
    const key = `${tenantId}|${assignedTo.toLowerCase()}`;
    let hit = userIds.get(key);
    if (!hit || Date.now() - hit.at > USER_TTL) {
      const u = await sf.query(`SELECT Id FROM User WHERE Email = '${assignedTo.replace(/'/g, "\\'")}' AND IsActive = true LIMIT 1`).catch(() => ({ records: [] as unknown[] }));
      hit = { id: (u.records[0] as { Id?: string } | undefined)?.Id ?? null, at: Date.now() };
      userIds.set(key, hit);
    }
    if (hit.id) return [hit.id];
  }
  // The run usually read the record already: use its owner instead of asking Salesforce again.
  if (ownerId?.startsWith('005')) return [ownerId];
  if (recordId && objectApiName && /^\w+$/.test(objectApiName) && /^[a-zA-Z0-9]{15,18}$/.test(recordId)) {
    const r = await sf.query(`SELECT OwnerId FROM ${objectApiName} WHERE Id = '${recordId}'`).catch(() => ({ records: [] }));
    const owner = (r.records[0] as { OwnerId?: string } | undefined)?.OwnerId;
    if (owner?.startsWith('005')) return [owner];
  }
  const { rows } = await pool.query('select sf_user_id from tenants where id=$1', [tenantId]);
  return rows[0]?.sf_user_id ? [rows[0].sf_user_id] : [];
}

/** Called after a run is saved. Best effort: never fails the run. */
export async function notifySalesforce(tenantId: string, runId: string): Promise<void> {
  try {
    const { rows } = await pool.query(
      `select r.status, r.input, r.output, r.assigned_to, r.started_by, r.steps, w.name, t.use_package
       from runs r left join workflows w on w.id = r.workflow_id join tenants t on t.id = r.tenant_id where r.id=$1`, [runId]);
    const r = rows[0];
    if (!r) return;
    const recordId: string | undefined = r.input?.recordId;
    const objectApiName: string | undefined = r.input?.objectApiName;
    const sf = await SalesforceClient.forTenant(tenantId);
    // Live-update events go to every open Agent Panel and count against the org's event delivery allowance:
    // only send them when someone could be looking (a record's page, a person started it, or it needs approval),
    // and not at all for optional updates while the org's API allowance is running low.
    const watched = !!recordId || !!r.started_by || r.status === 'waiting';
    if (r.use_package && watched && (r.status === 'waiting' || allowed(apiLevel(tenantId), 'background'))) {
      await sf.createRecord('CRMagents_Run_Event__e', {
        Run_Id__c: runId, Status__c: r.status, Record_Id__c: recordId ?? null,
        Agent_Name__c: String(r.name ?? 'Agent').slice(0, 255), Summary__c: String(r.output ?? '').slice(0, 255),
      }).catch(() => undefined);
    }
    if (r.status === 'waiting') {
      const typeId = await ensureNotificationType(tenantId, sf);
      const same = (id?: string) => !!id && !!recordId && id.slice(0, 15) === recordId.slice(0, 15);
      const ownerId = (r.steps as { output?: { record?: { Id?: string; OwnerId?: string } } }[] | null)
        ?.find((x) => same(x.output?.record?.Id) && x.output?.record?.OwnerId)?.output?.record?.OwnerId;
      const recipients = await approverUserId(sf, tenantId, r.assigned_to, recordId, objectApiName, ownerId);
      if (typeId && recipients.length) {
        await sf.rest('POST', '/actions/standard/customNotificationAction', {
          inputs: [{
            customNotifTypeId: typeId,
            recipientIds: recipients,
            title: `${r.name ?? 'An agent'} needs your approval`.slice(0, 250),
            body: 'Open the record to approve or reject. Nothing changes until someone decides.',
            ...(recordId ? { targetId: recordId } : { targetPageRef: JSON.stringify({ type: 'standard__webPage', attributes: { url: `${config.webUrl}/?tab=approvals` } }) }),
          }],
        });
      }
    }
  } catch { /* notifications are a convenience; the run itself already succeeded */ }
}
