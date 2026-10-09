import type { Workflow } from '@crmagents/shared';
import { pool } from '../db.js';
import { SalesforceClient } from './client.js';

// One-click "Add to Salesforce": a record-triggered Flow that calls the package's "Run CRMagents workflow" action
// on an asynchronous path (callouts are not allowed in the synchronous part of a record-triggered flow).
// v1 triggers on create only: "created or updated" could loop when the workflow itself updates the record.

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

export async function deployWorkflow(tenantId: string, workflowId: string) {
  const wf = await load(tenantId, workflowId);
  const trigger = wf.graph.nodes.find((n) => n.type === 'trigger.salesforce');
  const object = String(trigger?.config.objectApiName ?? '').trim();
  if (!object) throw new Error('Add a Salesforce record trigger with an object (for example Case) before adding it to Salesforce.');
  const sf = await SalesforceClient.forTenant(tenantId);

  const installed = await sf.query("SELECT Id FROM ApexClass WHERE Name = 'CRMRunWorkflowAction' LIMIT 1");
  if (!installed.records.length) throw new Error('The CRMagents package is not installed in this org. Re-run setup on the Connections page.');

  const flowName = flowNameFor(wf.name, workflowId);
  // Redeploy = replace: remove the previous Flow (and an old name, if the workflow was renamed).
  for (const old of new Set([wf.sf_flow_name, flowName].filter(Boolean) as string[])) await removeFlow(sf, old);

  const label = `CRMagents: ${wf.name}`.slice(0, 80);
  await sf.tooling('POST', '/sobjects/Flow', {
    FullName: flowName,
    Metadata: {
      label,
      description: `Runs the CRMagents workflow "${wf.name}" when a ${object} is created. Managed by CRMagents.`,
      processType: 'AutoLaunchedFlow',
      status: 'Active',
      apiVersion: 67,
      interviewLabel: `${label} {!$Flow.CurrentDateTime}`,
      processMetadataValues: [
        { name: 'BuilderType', value: { stringValue: 'LightningFlowBuilder' } },
        { name: 'CanvasMode', value: { stringValue: 'AUTO_LAYOUT_CANVAS' } },
      ],
      start: {
        locationX: 50, locationY: 0, object, recordTriggerType: 'Create', triggerType: 'RecordAfterSave',
        scheduledPaths: [{ connector: { targetReference: 'Run_CRMagents' }, pathType: 'AsyncAfterCommit' }],
      },
      actionCalls: [{
        name: 'Run_CRMagents', label: 'Run CRMagents workflow', locationX: 176, locationY: 323,
        actionName: 'CRMRunWorkflowAction', actionType: 'apex',
        inputParameters: [
          { name: 'workflowId', value: { stringValue: workflowId } },
          { name: 'recordId', value: { elementReference: '$Record.Id' } },
          { name: 'objectApiName', value: { stringValue: object } },
        ],
      }],
    },
  });
  await pool.query('update workflows set sf_flow_name=$2, sf_deployed_at=now() where id=$1', [workflowId, flowName]);
  return { flowName, object, trigger: 'created' as const };
}

export async function undeployWorkflow(tenantId: string, workflowId: string) {
  const wf = await load(tenantId, workflowId);
  if (wf.sf_flow_name) await removeFlow(await SalesforceClient.forTenant(tenantId), wf.sf_flow_name);
  await pool.query('update workflows set sf_flow_name=null, sf_deployed_at=null where id=$1', [workflowId]);
  return { ok: true };
}
