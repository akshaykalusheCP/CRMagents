// Workflow model + node catalog shared by the API (executes it) and the web app (edits it).

export interface WFNode {
  id: string;
  type: string;
  label?: string;
  position: { x: number; y: number };
  config: Record<string, any>;
}
export interface WFEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
}
export interface Workflow {
  nodes: WFNode[];
  edges: WFEdge[];
  /** Set when the workflow was drafted from a plain-English request (kept for follow-up edits). */
  meta?: { request?: string; plan?: unknown };
}

export type FieldKind = 'text' | 'textarea' | 'select' | 'tools' | 'number';
export interface FieldDef {
  key: string;
  label: string;
  kind: FieldKind;
  options?: string[];
  placeholder?: string;
  help?: string;
  default?: unknown;
}
export interface HandleDef {
  id: string;
  label: string;
}
export type Category = 'Trigger' | 'AI' | 'Salesforce' | 'Logic' | 'Integration' | 'Utility';
export interface NodeDef {
  type: string;
  label: string;
  category: Category;
  description: string;
  fields: FieldDef[];
  /** Keys this node adds to the run scope under its id, shown as references in the editor. */
  outputs: string[];
  handles?: HandleDef[]; // output handles; default is one handle 'out'
}

export const CATEGORY_COLORS: Record<Category, string> = {
  Trigger: '#188038',
  AI: '#9334e6',
  Salesforce: '#1a73e8',
  Logic: '#e37400',
  Integration: '#12b5cb',
  Utility: '#5f6368',
};

const OUT: HandleDef[] = [{ id: 'out', label: '' }];

/** Who can approve a paused run. Owner/manager are looked up in Salesforce and matched to people by email. */
export const APPROVERS = ['Anyone in the workspace', 'Record owner', "Record owner's manager", 'A specific person'] as const;

export const NODE_DEFS: NodeDef[] = [
  {
    type: 'trigger.manual',
    label: 'Manual / API trigger',
    category: 'Trigger',
    description: 'Starts the workflow with free text and optional context. Used for tests and API calls.',
    fields: [],
    outputs: ['input', 'context'],
  },
  {
    type: 'trigger.salesforce',
    label: 'Salesforce record trigger',
    category: 'Trigger',
    description: 'Starts when a record is created or changed in Salesforce (or when Salesforce calls it).',
    fields: [
      { key: 'objectApiName', label: 'Object', kind: 'text', placeholder: 'Case', help: 'The Salesforce object to watch, e.g. Case. Several: "Case, Lead" ({{trigger.objectApiName}} says which one).' },
      { key: 'event', label: 'Run when a record is', kind: 'select', options: ['created', 'created or updated', 'updated', 'deleted'], default: 'created', help: 'Deleted records are read from the Recycle Bin (kept 15 days).' },
      { key: 'changedFields', label: 'Only when these fields change (optional)', kind: 'text', placeholder: 'Status, Priority', help: 'For "updated" / "created or updated": run only when one of these fields gets a new value.' },
    ],
    outputs: ['recordId', 'objectApiName', 'deleted', 'input', 'context'],
  },
  {
    type: 'trigger.schedule',
    label: 'Schedule',
    category: 'Trigger',
    description: 'Runs on a schedule (every hour, day or week) once the agent is turned on.',
    fields: [
      { key: 'every', label: 'Run every', kind: 'select', options: ['day', 'hour', 'week'], default: 'day' },
      { key: 'at', label: 'At (HH:MM)', kind: 'text', placeholder: '08:00', default: '08:00', help: 'For daily and weekly runs (weekly runs on Mondays).' },
      { key: 'tz', label: 'Time zone', kind: 'text', placeholder: 'Asia/Kolkata', default: 'UTC', help: 'IANA name, e.g. Asia/Kolkata, Europe/London, America/New_York.' },
    ],
    outputs: ['input'],
  },
  {
    type: 'trigger.webhook',
    label: 'Webhook',
    category: 'Trigger',
    description: 'Starts when another system (a form, ServiceNow, Jira, your app) sends a request to this agent\'s web address. The JSON it sends is {{trigger.body}}.',
    fields: [
      { key: 'recordIdPath', label: 'Record Id in the body (optional)', kind: 'text', placeholder: 'caseId', help: 'If the body names a Salesforce record, its key here makes it {{trigger.recordId}}.' },
      { key: 'objectApiName', label: 'Object of that record (optional)', kind: 'text', placeholder: 'Case' },
    ],
    outputs: ['body', 'recordId', 'objectApiName', 'input'],
  },
  {
    type: 'ai.agent',
    label: 'AI agent',
    category: 'AI',
    description: 'An LLM that can call Salesforce tools to look things up and reason over them.',
    fields: [
      { key: 'instructions', label: 'Instructions', kind: 'textarea', placeholder: 'You are a support analyst...' },
      { key: 'prompt', label: 'Task', kind: 'textarea', placeholder: 'Summarize case {{trigger.recordId}}' },
      { key: 'tools', label: 'Tools', kind: 'tools' },
      { key: 'model', label: 'Model', kind: 'select', options: ['default', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'], default: 'default', help: 'default = platform model (Opus 5.5). Sonnet costs about half, Haiku about 1/40th; check results before switching.' },
      { key: 'effort', label: 'Effort', kind: 'select', options: ['default', 'low', 'medium', 'high'], default: 'default', help: 'Lower effort uses fewer tokens. default = the model\'s own setting.' },
    ],
    outputs: ['text'],
  },
  {
    type: 'ai.classify',
    label: 'Classify',
    category: 'AI',
    description: 'Pick exactly one category for a piece of text.',
    fields: [
      { key: 'text', label: 'Text to classify', kind: 'textarea', placeholder: '{{sf_get_1.record.Subject}}' },
      { key: 'categories', label: 'Categories (one per line)', kind: 'textarea', placeholder: 'Billing\nTechnical\nOther' },
      { key: 'instructions', label: 'Extra guidance (optional)', kind: 'textarea' },
      { key: 'escalate', label: 'If the cheaper model is unsure', kind: 'select', options: ['never', 'when unsure'], default: 'never', help: 'With a cheaper model selected, re-check uncertain answers with the default model. Off by default: on our test cases it cost ~40x more without better accuracy.' },
      { key: 'model', label: 'Model', kind: 'select', options: ['default', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'], default: 'default', help: 'default = platform model (Opus 5.5). Sonnet costs about half, Haiku about 1/40th; check results before switching.' },
      { key: 'effort', label: 'Effort', kind: 'select', options: ['default', 'low', 'medium', 'high'], default: 'default', help: 'Lower effort uses fewer tokens. default = the model\'s own setting.' },
    ],
    outputs: ['category', 'reason', 'confidence', 'escalated'],
  },
  {
    type: 'ai.extract',
    label: 'Extract data',
    category: 'AI',
    description: 'Pull structured fields out of text as JSON.',
    fields: [
      { key: 'text', label: 'Text', kind: 'textarea' },
      { key: 'fields', label: 'Fields (one per line: name: description)', kind: 'textarea', placeholder: 'score: number 0-100\nreason: short explanation' },
      { key: 'model', label: 'Model', kind: 'select', options: ['default', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'], default: 'default', help: 'default = platform model (Opus 5.5). Sonnet costs about half, Haiku about 1/40th; check results before switching.' },
      { key: 'effort', label: 'Effort', kind: 'select', options: ['default', 'low', 'medium', 'high'], default: 'default', help: 'Lower effort uses fewer tokens. default = the model\'s own setting.' },
    ],
    outputs: ['data'],
  },
  {
    type: 'sf.query',
    label: 'Query records (SOQL)',
    category: 'Salesforce',
    description: 'Run a read-only SOQL query. Use {{…table}} to give results to AI in a compact form. Template values are escaped automatically.',
    fields: [{ key: 'soql', label: 'SOQL', kind: 'textarea', placeholder: "SELECT Id, Subject FROM Case WHERE AccountId = '{{trigger.recordId}}' LIMIT 20" }],
    outputs: ['records', 'first', 'totalSize', 'table'],
  },
  {
    type: 'sf.getRecord',
    label: 'Get record',
    category: 'Salesforce',
    description: 'Fetch one record by object and Id.',
    fields: [
      { key: 'sobject', label: 'Object', kind: 'text', placeholder: 'Case' },
      { key: 'id', label: 'Record Id', kind: 'text', placeholder: '{{trigger.recordId}}' },
      { key: 'fields', label: 'Fields (optional, comma separated)', kind: 'text', placeholder: 'Subject, Description, Status', help: 'Fetching only the fields you use keeps AI prompts small.' },
    ],
    outputs: ['record'],
  },
  {
    type: 'sf.createRecord',
    label: 'Create record',
    category: 'Salesforce',
    description: 'Create a record. Fields are a JSON object.',
    fields: [
      { key: 'sobject', label: 'Object', kind: 'text', placeholder: 'Task' },
      { key: 'fields', label: 'Fields (JSON)', kind: 'textarea', placeholder: '{"Subject": "Follow up", "WhatId": "{{trigger.recordId}}"}' },
    ],
    outputs: ['id'],
  },
  {
    type: 'sf.updateRecord',
    label: 'Update record',
    category: 'Salesforce',
    description: 'Update fields on a record. Fields are a JSON object.',
    fields: [
      { key: 'sobject', label: 'Object', kind: 'text' },
      { key: 'id', label: 'Record Id', kind: 'text', placeholder: '{{trigger.recordId}}' },
      { key: 'fields', label: 'Fields (JSON)', kind: 'textarea', placeholder: '{"Priority": "High"}' },
    ],
    outputs: ['success'],
  },
  {
    type: 'sf.deleteRecord',
    label: 'Delete record',
    category: 'Salesforce',
    description: 'Delete a record. It stays in the Recycle Bin for 15 days.',
    fields: [
      { key: 'sobject', label: 'Object', kind: 'text' },
      { key: 'id', label: 'Record Id', kind: 'text', placeholder: '{{trigger.recordId}}' },
    ],
    outputs: ['success'],
  },
  {
    type: 'sf.upsertRecord',
    label: 'Create or update by external Id',
    category: 'Salesforce',
    description: 'Update the record with this external Id, or create it if there is none (e.g. an order number from another system).',
    fields: [
      { key: 'sobject', label: 'Object', kind: 'text', placeholder: 'Order__c' },
      { key: 'externalIdField', label: 'External Id field', kind: 'text', placeholder: 'Order_Number__c' },
      { key: 'externalId', label: 'External Id value', kind: 'text', placeholder: '{{trigger.body.orderNumber}}' },
      { key: 'fields', label: 'Fields (JSON)', kind: 'textarea', placeholder: '{"Status__c": "Shipped"}' },
    ],
    outputs: ['id', 'created'],
  },
  {
    type: 'sf.emailThread',
    label: 'Read email conversation',
    category: 'Salesforce',
    description: "The emails on a case (Email-to-Case), oldest first, with quoted earlier messages cut off. Works from a case or one of its emails.",
    fields: [
      { key: 'recordId', label: 'Case or email Id', kind: 'text', placeholder: '{{trigger.recordId}}' },
      { key: 'max', label: 'At most this many emails', kind: 'number', default: 15 },
    ],
    outputs: ['text', 'lastFrom', 'lastSubject', 'caseId', 'count'],
  },
  {
    type: 'sf.meetingTimes',
    label: 'Find meeting times',
    category: 'Salesforce',
    description: "Free times on people's Salesforce calendars (their Events), in working hours of their own time zone. Use the list in an email: \"Would one of these work?\".",
    fields: [
      { key: 'users', label: 'Whose calendar', kind: 'text', placeholder: '{{trigger.record.OwnerId}} or name@company.com', help: 'Emails or user Ids, separated by commas. With several, the earliest free person is offered.' },
      { key: 'days', label: 'Days ahead', kind: 'number', default: 7 },
      { key: 'duration', label: 'Meeting length (minutes)', kind: 'number', default: 30 },
      { key: 'count', label: 'How many times to offer', kind: 'number', default: 3 },
    ],
    outputs: ['text', 'slots', 'count'],
  },
  {
    type: 'sf.emailReply',
    label: 'Reply by email',
    category: 'Salesforce',
    description: 'Answer the customer on the case, in the same email thread. "A person sends it" puts the reply on the case for an agent to check, edit and send; "Send now" sends it right away.',
    fields: [
      { key: 'recordId', label: 'Case or email Id', kind: 'text', placeholder: '{{trigger.recordId}}' },
      { key: 'body', label: 'Reply', kind: 'textarea', placeholder: '{{ai_agent_1.text}}' },
      { key: 'mode', label: 'How it goes out', kind: 'select', options: ['suggest', 'send'], default: 'suggest', help: 'suggest = a person checks and sends it from the case (recommended); send = it goes out now.' },
      { key: 'to', label: 'To (optional)', kind: 'text', placeholder: 'The customer who wrote last' },
      { key: 'subject', label: 'Subject (optional)', kind: 'text', placeholder: 'Re: their subject' },
    ],
    outputs: ['sent', 'to', 'subject', 'text'],
  },
  {
    type: 'sf.readFiles',
    label: 'Read files',
    category: 'Salesforce',
    description: "The text of a record's attached files (PDF, Word, text, CSV, HTML), newest first, for an AI step to use.",
    fields: [
      { key: 'recordId', label: 'Record Id', kind: 'text', placeholder: '{{trigger.recordId}}' },
      { key: 'maxFiles', label: 'At most this many files', kind: 'number', default: 5 },
    ],
    outputs: ['text', 'files'],
  },
  {
    type: 'sf.attachFile',
    label: 'Attach file',
    category: 'Salesforce',
    description: 'Save text (a summary, a report, a CSV) as a file on the record.',
    fields: [
      { key: 'recordId', label: 'Record Id', kind: 'text', placeholder: '{{trigger.recordId}}' },
      { key: 'title', label: 'File name', kind: 'text', placeholder: 'Case summary' },
      { key: 'format', label: 'Format', kind: 'select', options: ['md', 'txt', 'csv', 'html', 'json'], default: 'md' },
      { key: 'content', label: 'Content', kind: 'textarea', placeholder: '{{ai_agent_1.text}}' },
    ],
    outputs: ['id'],
  },
  {
    type: 'sf.createTask',
    label: 'Create task',
    category: 'Salesforce',
    description: 'Shortcut to create a Task linked to a record.',
    fields: [
      { key: 'subject', label: 'Subject', kind: 'text' },
      { key: 'relatedTo', label: 'Related record Id', kind: 'text', placeholder: '{{trigger.recordId}}' },
      { key: 'description', label: 'Description', kind: 'textarea' },
      { key: 'ownerId', label: 'Owner Id (optional)', kind: 'text' },
    ],
    outputs: ['id'],
  },
  {
    type: 'sf.action',
    label: 'Run Salesforce action',
    category: 'Salesforce',
    description: "Run one of the org's own invocable Apex actions, autolaunched Flows, or a standard action (email, Chatter).",
    fields: [
      { key: 'action', label: 'Action', kind: 'text', placeholder: 'flow:Close_Case', help: 'apex:ClassName, flow:FlowApiName or standard:emailSimple' },
      { key: 'inputs', label: 'Inputs (JSON)', kind: 'textarea', placeholder: '{"recordId": "{{trigger.recordId}}"}' },
    ],
    outputs: ['success'],
  },
  {
    type: 'logic.branch',
    label: 'If / else',
    category: 'Logic',
    description: 'Follow the true or false path.',
    fields: [
      { key: 'left', label: 'Value', kind: 'text', placeholder: '{{ai_extract_1.data.score}}' },
      { key: 'operator', label: 'Operator', kind: 'select', options: ['equals', 'not_equals', 'contains', 'greater_than', 'less_than', 'is_empty', 'not_empty'], default: 'equals' },
      { key: 'right', label: 'Compare to', kind: 'text' },
    ],
    outputs: ['result'],
    handles: [{ id: 'true', label: 'true' }, { id: 'false', label: 'false' }],
  },
  {
    type: 'logic.loop',
    label: 'Loop over list',
    category: 'Logic',
    description: 'Run the "each" branch once per item (use {{item}} and {{index}}), then continue on "done".',
    fields: [
      { key: 'items', label: 'List', kind: 'text', placeholder: '{{sf_query_1.records}}' },
      { key: 'max', label: 'Max items', kind: 'number', default: 20 },
    ],
    outputs: ['results', 'count'],
    handles: [{ id: 'each', label: 'each' }, { id: 'done', label: 'done' }],
  },
  {
    type: 'logic.approval',
    label: 'Human approval',
    category: 'Logic',
    description: 'Pause until a person approves or rejects. Put it before any write you want reviewed.',
    fields: [
      { key: 'message', label: 'What needs approval', kind: 'textarea', placeholder: 'Create task: {{ai_agent_1.text}}' },
      { key: 'approver', label: 'Who approves', kind: 'select', options: [...APPROVERS], default: APPROVERS[0] },
      { key: 'approverEmail', label: 'Approver email (for "A specific person")', kind: 'text', placeholder: 'name@company.com' },
    ],
    outputs: ['approved'],
    handles: [{ id: 'approved', label: 'approved' }, { id: 'rejected', label: 'rejected' }],
  },
  {
    type: 'logic.wait',
    label: 'Wait',
    category: 'Logic',
    description: 'Pause the run for a while (or until a date), then carry on. For follow-ups like "if no reply in 3 days".',
    fields: [
      { key: 'mode', label: 'Wait', kind: 'select', options: ['For a while', 'Until a date and time'], default: 'For a while' },
      { key: 'amount', label: 'How long', kind: 'number', default: 1 },
      { key: 'unit', label: 'Unit', kind: 'select', options: ['minutes', 'hours', 'days'], default: 'days' },
      { key: 'until', label: 'Until (date/time or {{reference}})', kind: 'text', placeholder: '{{sf_get_1.record.Follow_Up_Date__c}}' },
    ],
    outputs: ['waitedUntil'],
  },
  {
    type: 'knowledge.search',
    label: 'Search knowledge',
    category: 'AI',
    description: "Find the best-matching sections in your uploaded documents (support guides, policies). No AI cost. Feed {{…text}} to an AI step so its answer follows your own guides.",
    fields: [
      { key: 'query', label: 'Look up', kind: 'textarea', placeholder: '{{sf_get_1.record.Subject}} {{sf_get_1.record.Description}}' },
      { key: 'limit', label: 'Sections', kind: 'number', default: 4 },
      { key: 'docs', label: 'Only these documents (optional)', kind: 'text', placeholder: 'Network Troubleshooting Guide', help: 'Document titles, comma-separated. Empty = all documents.' },
    ],
    outputs: ['text', 'sources', 'count'],
  },
  {
    type: 'crm.suggest',
    label: 'Show suggestion on record',
    category: 'Salesforce',
    description: 'Save advice on the record. People see it in the CRMagents Suggestions card on the record page. Changes nothing in Salesforce, so no approval is needed.',
    fields: [
      { key: 'title', label: 'Title', kind: 'text', placeholder: 'Suggested resolution' },
      { key: 'text', label: 'Suggestion', kind: 'textarea', placeholder: '{{ai_agent_1.text}}' },
      { key: 'recordId', label: 'Record Id', kind: 'text', placeholder: '{{trigger.recordId}}' },
      { key: 'sources', label: 'Sources (optional)', kind: 'text', placeholder: '{{kb_1.sources}}' },
    ],
    outputs: ['id', 'text'],
  },
  {
    type: 'http.request',
    label: 'HTTP request',
    category: 'Integration',
    description: 'Call any public HTTP API.',
    fields: [
      { key: 'method', label: 'Method', kind: 'select', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], default: 'GET' },
      { key: 'url', label: 'URL', kind: 'text', placeholder: 'https://api.example.com/items' },
      { key: 'headers', label: 'Headers (JSON)', kind: 'textarea', placeholder: '{"Authorization": "Bearer ..."}' },
      { key: 'body', label: 'Body', kind: 'textarea' },
    ],
    outputs: ['status', 'ok', 'body'],
  },
  {
    type: 'notify.slack',
    label: 'Slack message',
    category: 'Integration',
    description: 'Post to a Slack incoming webhook.',
    fields: [
      { key: 'webhookUrl', label: 'Webhook URL', kind: 'text', placeholder: 'https://hooks.slack.com/services/...' },
      { key: 'text', label: 'Message', kind: 'textarea' },
    ],
    outputs: ['ok'],
  },
  {
    type: 'notify.sms',
    label: 'Text message (SMS / WhatsApp)',
    category: 'Integration',
    description: "Send an SMS or WhatsApp message from your Twilio number (Settings → AI & spending → Text messages). WhatsApp only reaches people who messaged you in the last 24 hours, unless you use an approved template.",
    fields: [
      { key: 'to', label: 'To', kind: 'text', placeholder: '{{trigger.record.MobilePhone}}', help: 'International format, like +14155550100.' },
      { key: 'channel', label: 'Send as', kind: 'select', options: ['sms', 'whatsapp'], default: 'sms' },
      { key: 'text', label: 'Message', kind: 'textarea', placeholder: 'Hi {{trigger.record.FirstName}}, …' },
    ],
    outputs: ['sent', 'to', 'sid'],
  },
  {
    type: 'util.set',
    label: 'Set values',
    category: 'Utility',
    description: 'Build a JSON object from templates, to reuse later.',
    fields: [{ key: 'values', label: 'Values (JSON)', kind: 'textarea', placeholder: '{"subject": "Re: {{sf_get_1.record.Subject}}"}' }],
    outputs: ['values'],
  },
  {
    type: 'util.output',
    label: 'Return result',
    category: 'Utility',
    description: 'The value sent back to the caller (Salesforce) when the workflow finishes.',
    fields: [{ key: 'value', label: 'Result', kind: 'textarea', placeholder: '{{ai_agent_1.text}}' }],
    outputs: ['value'],
  },
];

/** Steps that change data or send it out; each can ask a person first. */
export const WRITE_NODE_TYPES = ['sf.createRecord', 'sf.updateRecord', 'sf.deleteRecord', 'sf.upsertRecord', 'sf.createTask', 'sf.action', 'notify.slack', 'http.request', 'sf.attachFile', 'sf.emailReply', 'notify.sms'];
for (const d of NODE_DEFS) {
  if (!WRITE_NODE_TYPES.includes(d.type)) continue;
  d.fields.push(
    { key: 'askFirst', label: 'Ask before running', kind: 'select', options: ['No', 'Yes'], default: 'No', help: 'Pause and ask a person before this step changes anything.' },
    { key: 'approver', label: 'Who approves', kind: 'select', options: [...APPROVERS], default: APPROVERS[0] },
    { key: 'approverEmail', label: 'Approver email (for "A specific person")', kind: 'text', placeholder: 'name@company.com' },
  );
}

export const NODE_DEF_BY_TYPE: Record<string, NodeDef> = Object.fromEntries(NODE_DEFS.map((d) => [d.type, d]));

export const TRIGGER_OUTPUTS = ['input', 'recordId', 'objectApiName', 'context'];

export function outputHandles(type: string): HandleDef[] {
  return NODE_DEF_BY_TYPE[type]?.handles ?? OUT;
}

/** Throws if the graph has a cycle or references unknown nodes. */
export function validateWorkflow(w: Workflow): void {
  const ids = new Set(w.nodes.map((n) => n.id));
  if (ids.size !== w.nodes.length) throw new Error('Duplicate node ids');
  for (const n of w.nodes) if (!NODE_DEF_BY_TYPE[n.type]) throw new Error(`Unknown node type ${n.type}`);
  for (const e of w.edges) if (!ids.has(e.source) || !ids.has(e.target)) throw new Error('Edge points to a missing node');
  topoOrder(w);
}

export function topoOrder(w: Workflow): string[] {
  const indeg = new Map(w.nodes.map((n) => [n.id, 0]));
  for (const e of w.edges) indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  const queue = w.nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const e of w.edges) {
      if (e.source !== id) continue;
      const d = (indeg.get(e.target) ?? 0) - 1;
      indeg.set(e.target, d);
      if (d === 0) queue.push(e.target);
    }
  }
  if (order.length !== w.nodes.length) throw new Error('Workflow has a cycle. Connections must flow one way.');
  return order;
}

// ---- Starter templates ----

export interface Template {
  id: string;
  name: string;
  description: string;
  workflow: Workflow;
}

const n = (id: string, type: string, x: number, y: number, config: Record<string, any> = {}): WFNode => ({
  id, type, position: { x, y }, config,
});
const e = (source: string, target: string, sourceHandle?: string): WFEdge => ({
  id: `${source}${sourceHandle ? ':' + sourceHandle : ''}->${target}`, source, target, sourceHandle: sourceHandle ?? 'out',
});

export const TEMPLATES: Template[] = [
  {
    id: 'list-leads-no-ai',
    name: 'Recent leads (no AI, $0)',
    description: 'Lists the newest leads with a plain query. No AI tokens: fetching data never needs a model.',
    workflow: {
      nodes: [
        n('trigger_1', 'trigger.manual', 0, 60),
        n('sf_query_1', 'sf.query', 280, 60, {
          soql: 'SELECT Name, Company, Status, LeadSource, CreatedDate FROM Lead ORDER BY CreatedDate DESC LIMIT 20',
        }),
        n('output_1', 'util.output', 560, 60, { value: '{{sf_query_1.totalSize}} leads:\n{{sf_query_1.table}}' }),
      ],
      edges: [e('trigger_1', 'sf_query_1'), e('sf_query_1', 'output_1')],
    },
  },
  {
    id: 'case-triage-rules-first',
    name: 'Case triage, rules first',
    description: 'Skips closed cases and routes obvious billing cases by keyword with no AI; only the rest are classified by AI.',
    workflow: {
      nodes: [
        n('trigger_1', 'trigger.salesforce', 0, 160, { objectApiName: 'Case' }),
        n('sf_get_1', 'sf.getRecord', 260, 160, { sobject: 'Case', id: '{{trigger.recordId}}', fields: 'Subject, Description, Status' }),
        n('branch_1', 'logic.branch', 520, 160, { left: '{{sf_get_1.record.Status}}', operator: 'equals', right: 'Closed' }, ),
        n('output_1', 'util.output', 800, 20, { value: 'Skipped: case is closed (no AI used).' }),
        n('branch_2', 'logic.branch', 800, 220, {
          left: '{{sf_get_1.record.Subject}} {{sf_get_1.record.Description}}', operator: 'contains', right: 'refund',
        }),
        n('sf_task_1', 'sf.createTask', 1080, 120, {
          subject: 'Triage: Billing (rule)', relatedTo: '{{trigger.recordId}}', description: 'Matched the keyword rule "refund". No AI used.',
        }),
        n('output_2', 'util.output', 1340, 120, { value: 'Classified as Billing by rule (no AI used).' }),
        n('ai_classify_1', 'ai.classify', 1080, 320, {
          text: 'Subject: {{sf_get_1.record.Subject}}\nDescription: {{sf_get_1.record.Description}}',
          categories: 'Billing\nTechnical issue\nAccount access\nFeature request\nOther',
          model: 'claude-haiku-5-5', // eval: same accuracy as Opus on real cases at ~2% of the cost
        }),
        n('sf_task_2', 'sf.createTask', 1340, 320, {
          subject: 'Triage: {{ai_classify_1.category}}', relatedTo: '{{trigger.recordId}}',
          description: 'AI classified as {{ai_classify_1.category}}. Reason: {{ai_classify_1.reason}}',
        }),
        n('output_3', 'util.output', 1600, 320, { value: 'Classified as {{ai_classify_1.category}} by AI.' }),
      ],
      edges: [
        e('trigger_1', 'sf_get_1'), e('sf_get_1', 'branch_1'),
        e('branch_1', 'output_1', 'true'), e('branch_1', 'branch_2', 'false'),
        e('branch_2', 'sf_task_1', 'true'), e('sf_task_1', 'output_2'),
        e('branch_2', 'ai_classify_1', 'false'), e('ai_classify_1', 'sf_task_2'), e('sf_task_2', 'output_3'),
      ],
    },
  },
  {
    id: 'case-triage',
    name: 'Case triage',
    description: 'Classify a new case and create a follow-up task tagged with the category.',
    workflow: {
      nodes: [
        n('trigger_1', 'trigger.salesforce', 0, 80, { objectApiName: 'Case' }),
        n('sf_get_1', 'sf.getRecord', 280, 80, { sobject: 'Case', id: '{{trigger.recordId}}', fields: 'Subject, Description' }),
        n('ai_classify_1', 'ai.classify', 560, 80, {
          text: 'Subject: {{sf_get_1.record.Subject}}\nDescription: {{sf_get_1.record.Description}}',
          categories: 'Billing\nTechnical issue\nAccount access\nFeature request\nOther',
          model: 'claude-haiku-5-5', // eval: same accuracy as Opus on real cases at ~2% of the cost
        }),
        n('sf_task_1', 'sf.createTask', 840, 80, {
          subject: 'Triage: {{ai_classify_1.category}}',
          relatedTo: '{{trigger.recordId}}',
          description: 'Auto-triaged as {{ai_classify_1.category}}. Reason: {{ai_classify_1.reason}}',
        }),
        n('output_1', 'util.output', 1120, 80, { value: 'Classified as {{ai_classify_1.category}}' }),
      ],
      edges: [e('trigger_1', 'sf_get_1'), e('sf_get_1', 'ai_classify_1'), e('ai_classify_1', 'sf_task_1'), e('sf_task_1', 'output_1')],
    },
  },
  {
    id: 'lead-qualification',
    name: 'Lead qualification',
    description: 'Score a lead 0-100 and create a call task for hot leads.',
    workflow: {
      nodes: [
        n('trigger_1', 'trigger.salesforce', 0, 120, { objectApiName: 'Lead' }),
        n('sf_get_1', 'sf.getRecord', 280, 120, {
          sobject: 'Lead', id: '{{trigger.recordId}}',
          fields: 'Name, Title, Company, Industry, AnnualRevenue, NumberOfEmployees, LeadSource, Status, Rating, Description',
        }),
        n('ai_extract_1', 'ai.extract', 560, 120, {
          text: '{{sf_get_1.record}}',
          fields: 'score: number 0-100, how likely this lead is to buy\nreason: one-sentence justification',
        }),
        n('branch_1', 'logic.branch', 840, 120, { left: '{{ai_extract_1.data.score}}', operator: 'greater_than', right: '70' }),
        n('sf_task_1', 'sf.createTask', 1120, 20, {
          subject: 'Call hot lead (score {{ai_extract_1.data.score}})',
          relatedTo: '{{trigger.recordId}}',
          description: '{{ai_extract_1.data.reason}}',
        }),
        n('output_1', 'util.output', 1400, 120, { value: 'Score {{ai_extract_1.data.score}}: {{ai_extract_1.data.reason}}' }),
      ],
      edges: [
        e('trigger_1', 'sf_get_1'), e('sf_get_1', 'ai_extract_1'), e('ai_extract_1', 'branch_1'),
        e('branch_1', 'sf_task_1', 'true'), e('sf_task_1', 'output_1'), e('branch_1', 'output_1', 'false'),
      ],
    },
  },
  {
    id: 'account-summary',
    name: 'Account 360 summary',
    description: 'An agent researches an account (opportunities, cases, contacts) and writes a briefing.',
    workflow: {
      nodes: [
        n('trigger_1', 'trigger.salesforce', 0, 60, { objectApiName: 'Account' }),
        n('ai_agent_1', 'ai.agent', 300, 60, {
          instructions: 'You are a sales and support analyst. Be concise and factual. Only state what the data shows.',
          prompt: 'Write a briefing for Account {{trigger.recordId}}: key contacts, open opportunities, recent and open cases, and risks or next steps.',
          tools: ['soql_query', 'get_record', 'describe_object'],
        }),
        n('output_1', 'util.output', 600, 60, { value: '{{ai_agent_1.text}}' }),
      ],
      edges: [e('trigger_1', 'ai_agent_1'), e('ai_agent_1', 'output_1')],
    },
  },
  {
    id: 'ask-salesforce',
    name: 'Ask Salesforce (natural-language reports)',
    description: 'Answer any question about your data by writing and running SOQL.',
    workflow: {
      nodes: [
        n('trigger_1', 'trigger.manual', 0, 60),
        n('ai_agent_1', 'ai.agent', 280, 60, {
          instructions: 'You answer questions about Salesforce data. Use describe_object to confirm field names, then soql_query. Show the numbers you found and mention the query you used.',
          prompt: '{{trigger.input}}',
          tools: ['soql_query', 'describe_object'],
        }),
        n('output_1', 'util.output', 580, 60, { value: '{{ai_agent_1.text}}' }),
      ],
      edges: [e('trigger_1', 'ai_agent_1'), e('ai_agent_1', 'output_1')],
    },
  },
  {
    id: 'opportunity-next-step',
    name: 'Opportunity next step (with approval)',
    description: 'Suggest a next step for an opportunity, wait for approval, then create the task.',
    workflow: {
      nodes: [
        n('trigger_1', 'trigger.salesforce', 0, 100, { objectApiName: 'Opportunity' }),
        n('ai_agent_1', 'ai.agent', 280, 100, {
          instructions: 'You are a sales coach. Suggest ONE concrete next action in a single sentence.',
          prompt: 'Look at Opportunity {{trigger.recordId}} (stage, amount, close date, recent tasks and events) and recommend the next step.',
          tools: ['get_record', 'soql_query'],
        }),
        n('approval_1', 'logic.approval', 560, 100, { message: 'Create this follow-up task?\n\n{{ai_agent_1.text}}' }),
        n('sf_task_1', 'sf.createTask', 840, 20, {
          subject: 'Next step',
          relatedTo: '{{trigger.recordId}}',
          description: '{{ai_agent_1.text}}',
        }),
        n('output_1', 'util.output', 1120, 100, { value: '{{ai_agent_1.text}}' }),
      ],
      edges: [
        e('trigger_1', 'ai_agent_1'), e('ai_agent_1', 'approval_1'),
        e('approval_1', 'sf_task_1', 'approved'), e('sf_task_1', 'output_1'), e('approval_1', 'output_1', 'rejected'),
      ],
    },
  },
  {
    id: 'stale-case-followups',
    name: 'Stale case follow-ups (loop)',
    description: 'Find open cases untouched for 7+ days and draft a follow-up for each.',
    workflow: {
      nodes: [
        n('trigger_1', 'trigger.manual', 0, 100),
        n('sf_query_1', 'sf.query', 260, 100, {
          soql: 'SELECT Id, CaseNumber, Subject, Status FROM Case WHERE IsClosed = false AND LastModifiedDate < LAST_N_DAYS:7 LIMIT 10',
        }),
        n('loop_1', 'logic.loop', 540, 100, { items: '{{sf_query_1.records}}', max: 10 }),
        n('ai_agent_1', 'ai.agent', 820, 20, {
          instructions: 'Write a short, friendly customer follow-up email. No placeholders.',
          prompt: 'Draft a follow-up for case {{item.CaseNumber}}: {{item.Subject}} (status {{item.Status}}).',
          tools: [],
        }),
        n('output_1', 'util.output', 820, 220, { value: 'Drafted {{loop_1.count}} follow-ups:\n\n{{loop_1.results}}' }),
      ],
      edges: [e('trigger_1', 'sf_query_1'), e('sf_query_1', 'loop_1'), e('loop_1', 'ai_agent_1', 'each'), e('loop_1', 'output_1', 'done')],
    },
  },
];

// ---- Use-case library ----
// Proven jobs businesses hand to CRM agents, as plain-English requests for the AI builder: it adapts each one to
// the org's own objects, fields and picklist values instead of shipping a fixed graph.

export type UseCaseArea = 'Service' | 'Sales' | 'Operations' | 'Leadership';
export interface UseCase {
  id: string;
  area: UseCaseArea;
  title: string;
  /** The problem in the customer's words. */
  problem: string;
  /** What the builder is asked to build. */
  request: string;
  /** What it relies on beyond a connected org. */
  needs?: ('knowledge' | 'package' | 'slack')[];
  /** Typical AI cost per run. */
  cost: string;
}

export const USE_CASES: UseCase[] = [
  { id: 'case-triage', area: 'Service', title: 'Triage new cases', cost: '< $0.01',
    problem: 'New cases sit unsorted until someone reads them.',
    request: 'When a new Case is created, read the subject and description, set the Type and Priority, and add a one-line reason as a case comment task. Ask for approval before changing the case.' },
  { id: 'case-fix-from-guides', area: 'Service', title: 'Suggest fixes from your guides', cost: '~ $0.02', needs: ['knowledge', 'package'],
    problem: 'Agents search manuals for the same answers every day.',
    request: 'When a new Case is created, look up our support guides using the case subject and description, write short troubleshooting steps for the support agent, and show them as a suggestion on the case.' },
  { id: 'email-replies', area: 'Service', title: 'Draft replies to customer emails', cost: '~ $0.02', needs: ['knowledge', 'package'],
    problem: 'Replying to every customer email by hand is slow.',
    request: 'When a customer emails on a case (a new incoming EmailMessage), read the email conversation, check our support guides, and draft a short, friendly reply that answers them. Put it on the case for a person to check and send.' },
  { id: 'waiting-on-customer', area: 'Service', title: 'Chase cases waiting on the customer', cost: '~ $0.01', needs: ['package'],
    problem: 'Cases stall when customers stop replying.',
    request: 'Every day at 9:00, find open Cases with Status "Waiting on Customer" not modified in the last 3 days. For each one, read the email conversation and draft a polite follow-up email asking for the missing information, for a person to check and send.' },
  { id: 'escalation-watch', area: 'Service', title: 'Flag urgent cases nobody picked up', cost: 'free', needs: ['slack'],
    problem: 'High-priority cases get missed.',
    request: 'Every hour, find open Cases with Priority High that are still New and were created more than 4 hours ago. For each, create a task for the case owner to pick it up now, and post the list to Slack.' },
  { id: 'case-close-summary', area: 'Service', title: 'Summarise cases when they close', cost: '~ $0.01',
    problem: 'Nobody writes down how a case was solved.',
    request: 'When a Case is updated and its Status changes to Closed, read the case and its email conversation, write a 3-line summary of the problem and the fix, and save it in the case description after the existing text. Ask for approval first.' },

  { id: 'lead-scoring', area: 'Sales', title: 'Qualify and score new leads', cost: '< $0.01',
    problem: 'Reps waste time on leads that will never buy.',
    request: 'When a new Lead is created, score how well it fits our ideal customer from 0 to 100 using company, title, industry and lead source, set the Rating to Hot, Warm or Cold from the score, and add the reason in a task for the owner. Ask for approval first.' },
  { id: 'lead-research', area: 'Sales', title: 'Research new leads on the web', cost: '~ $0.05',
    problem: 'Reps go into first calls knowing nothing about the company.',
    request: 'When a new Lead is created, research the lead\'s company on the web: what they do, size, recent news and funding. Create a task for the lead owner with a short briefing and two talking points.' },
  { id: 'case-solved-text', area: 'Service', title: 'Text customers when their case is solved', cost: 'free',
    problem: 'Customers keep calling to ask if their issue is fixed.',
    request: 'When a Case is closed, send the case contact a short SMS on their mobile phone saying it is solved, with the case number, and that they can reply to this text if they still need help. Ask before sending.' },
  { id: 'offer-meeting', area: 'Sales', title: 'Offer meeting times to new leads', cost: '~ $0.01',
    problem: 'Inbound leads wait days for a reply, and back-and-forth over times loses them.',
    request: 'When a new Lead is created from the website, find 3 free times on the lead owner\'s calendar, write a short friendly email to the lead offering them, and send it to the lead with the Send Email action. Ask the owner before sending.' },
  { id: 'stale-deals', area: 'Sales', title: 'Nudge owners on stale deals', cost: '~ $0.01',
    problem: 'Deals go quiet and slip out of the quarter.',
    request: 'Every Monday at 8:00, find open Opportunities with no activity in the last 14 days. For each, create a task for the owner with a suggested next step based on the stage and amount.' },
  { id: 'past-close-date', area: 'Sales', title: 'Clean up past-due close dates', cost: 'free',
    problem: 'Forecasts are wrong because close dates are in the past.',
    request: 'Every day at 8:00, find open Opportunities whose Close Date is in the past and create a task for each owner to update the close date or close the deal.' },
  { id: 'pipeline-digest', area: 'Sales', title: 'Weekly pipeline digest', cost: '~ $0.02', needs: ['slack'],
    problem: 'Managers build the same pipeline update by hand every week.',
    request: 'Every Monday at 8:00, look at open Opportunities by stage, deals that moved this week, deals closing this month and the biggest risks, and write a short pipeline digest. Post it to Slack.' },
  { id: 'renewal-risk', area: 'Sales', title: 'Spot renewals at risk', cost: '~ $0.02',
    problem: 'Unhappy customers renew late or churn without warning.',
    request: 'Every week, find Opportunities closing in the next 60 days whose Account has open high-priority Cases. For each, write a short risk note and create a task for the opportunity owner to call the customer.' },

  { id: 'duplicates', area: 'Operations', title: 'Find duplicate leads and contacts', cost: 'free',
    problem: 'Duplicates confuse reps and inflate reports.',
    request: 'Every Monday, find Leads and Contacts that share the same email address, and create one task for the data owner listing each duplicate group with record links.' },
  { id: 'fill-missing-data', area: 'Operations', title: 'Fill in missing account details', cost: '~ $0.05',
    problem: 'Half the accounts have no industry or size.',
    request: 'When an Account is created with an empty Industry, research the company on the web and set Industry, Number of Employees and Website from what you find. Ask for approval first.' },
  { id: 'lead-routing', area: 'Operations', title: 'Route leads to the right owner', cost: 'free',
    problem: 'Leads wait in a queue until someone assigns them.',
    request: 'When a new Lead is created, assign it to an owner based on its Country: India to the India team owner, United States and Canada to the North America owner, everyone else to the international owner. Ask me for the owners\' names if you need them.' },

  { id: 'monday-briefing', area: 'Leadership', title: 'Monday business briefing', cost: '~ $0.03', needs: ['slack'],
    problem: 'Leaders start the week without a clear picture.',
    request: 'Every Monday at 7:30, summarise last week: new and won deals with amounts, pipeline change, new and closed cases, and the three things that need attention this week. Post it to Slack.' },
];

// ---- Team roles ----
/** owner: the person who signed up (one or more); admin: everything; builder: agents, assistants, guides; approver: approve, review, ask. */
export type Role = 'owner' | 'admin' | 'builder' | 'approver';
export const ROLES: { id: Exclude<Role, 'owner'>; label: string; help: string }[] = [
  { id: 'admin', label: 'Admin', help: 'Everything, including Salesforce connections, settings, team and billing-related limits.' },
  { id: 'builder', label: 'Builder', help: 'Builds and runs agents, assistants, dashboards and guides. No settings or team.' },
  { id: 'approver', label: 'Approver', help: 'Approves changes, reviews runs and suggestions, asks assistants. Cannot change agents.' },
];
const RANK: Record<Role, number> = { approver: 1, builder: 2, admin: 3, owner: 4 };
/** Does `role` include what `need` allows? */
export const roleAtLeast = (role: string | undefined, need: Role) => (RANK[role as Role] ?? 0) >= RANK[need];
