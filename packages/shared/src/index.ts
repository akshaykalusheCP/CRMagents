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
      { key: 'objectApiName', label: 'Object', kind: 'text', placeholder: 'Case', help: 'The Salesforce object to watch, e.g. Case or Lead.' },
      { key: 'event', label: 'Run when a record is', kind: 'select', options: ['created', 'created or updated'], default: 'created', help: 'When the agent is turned on, CRMagents checks for these every minute.' },
    ],
    outputs: ['recordId', 'objectApiName', 'input', 'context'],
  },
  {
    type: 'trigger.schedule',
    label: 'Schedule',
    category: 'Trigger',
    description: 'Runs on a schedule (every hour, day or week) once the agent is turned on.',
    fields: [
      { key: 'every', label: 'Run every', kind: 'select', options: ['day', 'hour', 'week'], default: 'day' },
      { key: 'at', label: 'At (UTC, HH:MM)', kind: 'text', placeholder: '08:00', default: '08:00', help: 'For daily and weekly runs (weekly runs on Mondays).' },
    ],
    outputs: ['input'],
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
export const WRITE_NODE_TYPES = ['sf.createRecord', 'sf.updateRecord', 'sf.createTask', 'sf.action', 'notify.slack', 'http.request'];
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
