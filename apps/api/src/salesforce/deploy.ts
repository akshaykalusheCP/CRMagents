import type { Workflow } from '@crmagents/shared';
import { pool } from '../db.js';
import { SalesforceClient } from './client.js';
import { triggersOf } from '../engine/watcher.js';

// "Push from Salesforce": a record-triggered Flow per watched object that calls the package's "Run Nimbus
// workflow" action on an asynchronous path (callouts are not allowed in the synchronous part of a record-triggered
// flow). Records arrive the moment they are saved, with no API calls and no change-event slots. Edits made by
// Nimbus itself never start it, so an agent that updates its own record can't loop.

const flowNameFor = (name: string, workflowId: string) => {
  const slug = name.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'Workflow';
  return `CRMagents_${/^[A-Za-z]/.test(slug) ? slug : `W_${slug}`}_${workflowId.replace(/-/g, '').slice(0, 8)}`.replace(/__+/g, '_');
};

async function load(tenantId: string, workflowId: string) {
  const { rows } = await pool.query('select name, graph, sf_flow_name from workflows where id=$1 and tenant_id=$2', [workflowId, tenantId]);
  if (!rows[0]) throw Object.assign(new Error('workflow not found'), { statusCode: 404 });
  return rows[0] as { name: string; graph: Workflow; sf_flow_name: string | null };
}

async function removeFlow(sf: SalesforceClient, flowName: string) {
  const defs = await sf.toolingQuery<{ Id: string }>(`SELECT Id FROM FlowDefinition WHERE DeveloperName = '${flowName}'`);
  const def = defs.records[0];
  if (!def) return;
  await sf.tooling('PATCH', `/sobjects/FlowDefinition/${def.Id}`, { Metadata: { activeVersionNumber: 0 } });
  const versions = await sf.toolingQuery<{ Id: string }>(`SELECT Id FROM Flow WHERE DefinitionId = '${def.Id}'`);
  for (const v of versions.records) await sf.tooling('DELETE', `/sobjects/Flow/${v.Id}`);
}

/** Start conditions for the Flow: our own edits never start it, and "only when these fields change". Pure; tested. */
export function flowStart(object: string, event: string, changed: string[], ownUserId: string | null) {
  const recordTriggerType = event === 'created' ? 'Create' : event === 'updated' ? 'Update' : 'CreateAndUpdate';
  const filters: { field: string; operator: string; value: Record<string, unknown> }[] = [];
  // Salesforce only knows "is changed" for updates: with "created or updated", new records still start it.
  const useChanged = changed.length > 0 && recordTriggerType === 'Update';
  if (useChanged) for (const f of changed) filters.push({ field: f, operator: 'IsChanged', value: { booleanValue: true } });
  const own = recordTriggerType !== 'Create' && ownUserId ? filters.push({ field: 'LastModifiedById', operator: 'NotEqualTo', value: { stringValue: ownUserId } }) : 0;
  const n = filters.length;
  const filterLogic = !n ? undefined
    : useChanged && own ? `(${changed.map((_, i) => i + 1).join(' OR ')}) AND ${n}`
    : useChanged ? changed.map((_, i) => i + 1).join(' OR ')
    : 'and';
  return {
    locationX: 50, locationY: 0, object, recordTriggerType, triggerType: 'RecordAfterSave',
    ...(n ? { filterLogic, filters } : {}),
    scheduledPaths: [{ connector: { targetReference: 'Run_CRMagents' }, pathType: 'AsyncAfterCommit' }],
  };
}

export async function deployWorkflow(tenantId: string, workflowId: string) {
  const wf = await load(tenantId, workflowId);
  const trigs = triggersOf(wf.graph);
  if (!trigs.length) throw new Error('Add a Salesforce record trigger with an object (for example Case) before adding it to Salesforce.');
  if (trigs[0].event === 'deleted') throw new Error('Salesforce Flows can\'t send deleted records to Nimbus. Keep this agent on real-time changes or regular checks.');
  const sf = await SalesforceClient.forTenant(tenantId);

  const installed = await sf.query("SELECT Id FROM ApexClass WHERE Name = 'CRMRunWorkflowAction' LIMIT 1");
  if (!installed.records.length) throw new Error('The Nimbus package is not installed in this org. Re-run setup on the Connections page.');
  const { rows } = await pool.query('select sf_user_id from tenants where id=$1', [tenantId]);
  const ownUserId: string | null = rows[0]?.sf_user_id ?? null;

  // Redeploy = replace: remove the previous Flows first.
  for (const old of (wf.sf_flow_name ?? '').split(',').filter(Boolean)) await removeFlow(sf, old);
  const names: string[] = [];
  for (const t of trigs) {
    const flowName = flowNameFor(trigs.length > 1 ? `${wf.name}_${t.object}` : wf.name, workflowId);
    await removeFlow(sf, flowName);
    const label = `Nimbus: ${wf.name}${trigs.length > 1 ? ` (${t.object})` : ''}`.slice(0, 80);
    await sf.tooling('POST', '/sobjects/Flow', {
      FullName: flowName,
      Metadata: {
        label,
        description: `Sends each ${t.object} ${t.event === 'created' ? 'created' : t.event === 'updated' ? 'updated' : 'created or updated'} to the Nimbus agent "${wf.name}". Managed by Nimbus.`,
        processType: 'AutoLaunchedFlow',
        status: 'Active',
        apiVersion: 67,
        interviewLabel: `${label} {!$Flow.CurrentDateTime}`,
        processMetadataValues: [
          { name: 'BuilderType', value: { stringValue: 'LightningFlowBuilder' } },
          { name: 'CanvasMode', value: { stringValue: 'AUTO_LAYOUT_CANVAS' } },
        ],
        start: flowStart(t.object, t.event, t.changed, ownUserId),
        actionCalls: [{
          name: 'Run_CRMagents', label: 'Run Nimbus workflow', locationX: 176, locationY: 323,
          actionName: 'CRMRunWorkflowAction', actionType: 'apex',
          inputParameters: [
            { name: 'workflowId', value: { stringValue: workflowId } },
            { name: 'recordId', value: { elementReference: '$Record.Id' } },
            { name: 'objectApiName', value: { stringValue: t.object } },
          ],
        }],
      },
    });
    names.push(flowName);
  }
  await pool.query('update workflows set sf_flow_name=$2, sf_deployed_at=now() where id=$1', [workflowId, names.join(',')]);
  return { flowName: names.join(', '), object: trigs.map((t) => t.object).join(', '), trigger: trigs[0].event };
}

export async function undeployWorkflow(tenantId: string, workflowId: string) {
  const wf = await load(tenantId, workflowId);
  if (wf.sf_flow_name) {
    const sf = await SalesforceClient.forTenant(tenantId);
    for (const name of wf.sf_flow_name.split(',').filter(Boolean)) await removeFlow(sf, name);
  }
  await pool.query('update workflows set sf_flow_name=null, sf_deployed_at=null where id=$1', [workflowId]);
  return { ok: true };
}
