// The compact plan the AI writes for a plain-English request. Code (compile.ts) turns it into a full workflow,
// so the model only spends tokens on understanding the request, not on wiring blocks together.

export const OPERATORS = ['equals', 'not_equals', 'contains', 'greater_than', 'less_than', 'is_empty', 'not_empty'] as const;
export const ACTIONS = ['classify', 'extract', 'ai_write', 'research', 'query', 'create_task', 'update_record', 'create_record', 'notify_slack', 'run_action', 'wait', 'search_knowledge', 'suggest', 'delete_record', 'read_files', 'attach_file', 'web_research', 'read_emails', 'reply_email', 'meeting_times', 'send_text'] as const;

export type Action = (typeof ACTIONS)[number];

export interface PlanStep {
  action: Action;
  /** What the AI should do (classify/extract guidance, text to write, research question). */
  instruction: string;
  /** Fields of the triggering record the step reads. */
  input_fields: string[];
  /** classify: the category names. */
  categories: string[];
  /** extract: the values to pull out. */
  outputs: { name: string; description: string }[];
  /** query / create_record: object API name. */
  object: string;
  /** update_record / create_record: values to set. query: fields to select (value ignored). */
  fields: { field: string; value: string }[];
  /** create_task subject. */
  subject: string;
  /** create_task description, Slack message. */
  message: string;
  /** query WHERE clause (SOQL, without the word WHERE). */
  where: string;
  limit: number;
  /** Run this step only when the condition holds (value empty = always). value can reference {stepN.key} / {record.Field}. */
  only_if: { value: string; operator: (typeof OPERATORS)[number]; compare: string };
  /** query only: run all following steps once per found record ({item.Field} references a field of that record). */
  per_record: boolean;
  /** run_action: which org action ("flow:Name", "apex:Name", "standard:emailSimple"); its inputs go in fields. */
  org_action?: string;
  /** wait: how long to pause before the next steps. */
  wait_amount?: number;
  wait_unit?: 'minutes' | 'hours' | 'days';
  /** reply_email: send right away instead of a person checking and sending it. */
  send_now?: boolean;
}

export const TRIGGER_EVENTS = ['created', 'created or updated', 'updated', 'deleted'] as const;

export interface Plan {
  name: string;
  trigger_kind: 'record' | 'manual' | 'schedule' | 'webhook';
  /** record only. Older plans have none ("created"). */
  trigger_event?: (typeof TRIGGER_EVENTS)[number];
  /** record only: run only when one of these fields changes. */
  changed_fields?: string[];
  /** schedule only. */
  schedule: { every: 'hour' | 'day' | 'week'; at: string };
  trigger_object: string;
  /** Run only when all of these are true on the triggering record. */
  conditions: { field: string; operator: (typeof OPERATORS)[number]; value: string }[];
  steps: PlanStep[];
  require_approval: boolean;
  /** Filled instead of steps when the request is too vague to build. */
  questions: string[];
}

/** JSON schema for structured output; enums keep the model to real objects and fields. */
export function planSchema(objects: string[], fields: string[], actions: string[] = []): Record<string, unknown> {
  const fieldEnum = fields.length ? fields : ['Id'];
  const str = { type: 'string' };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'trigger_kind', 'trigger_object', 'trigger_event', 'changed_fields', 'schedule', 'conditions', 'steps', 'require_approval', 'questions'],
    properties: {
      name: { type: 'string', description: 'Short workflow name' },
      trigger_kind: { type: 'string', enum: ['record', 'manual', 'schedule', 'webhook'] },
      trigger_event: { type: 'string', enum: [...TRIGGER_EVENTS] },
      changed_fields: { type: 'array', items: { type: 'string', enum: fieldEnum } },
      schedule: {
        type: 'object', additionalProperties: false, required: ['every', 'at'],
        properties: { every: { type: 'string', enum: ['hour', 'day', 'week'] }, at: { type: 'string', description: 'HH:MM in the admin\'s time zone; "08:00" if not given' } },
      },
      trigger_object: { type: 'string', enum: [...objects, ''] },
      conditions: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false, required: ['field', 'operator', 'value'],
          properties: { field: { type: 'string', enum: fieldEnum }, operator: { type: 'string', enum: [...OPERATORS] }, value: str },
        },
      },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['action', 'instruction', 'input_fields', 'categories', 'outputs', 'object', 'fields', 'subject', 'message', 'where', 'limit', 'only_if', 'per_record', 'org_action', 'wait_amount', 'wait_unit', 'send_now'],
          properties: {
            action: { type: 'string', enum: [...ACTIONS] },
            instruction: str,
            input_fields: { type: 'array', items: { type: 'string', enum: fieldEnum } },
            categories: { type: 'array', items: str },
            outputs: {
              type: 'array',
              items: { type: 'object', additionalProperties: false, required: ['name', 'description'], properties: { name: str, description: str } },
            },
            object: str,
            fields: {
              type: 'array',
              items: { type: 'object', additionalProperties: false, required: ['field', 'value'], properties: { field: str, value: str } },
            },
            subject: str,
            message: str,
            where: str,
            limit: { type: 'integer' },
            per_record: { type: 'boolean' },
            org_action: { type: 'string', enum: [...actions, ''] },
            wait_amount: { type: 'integer' },
            wait_unit: { type: 'string', enum: ['minutes', 'hours', 'days'] },
            send_now: { type: 'boolean' },
            only_if: {
              type: 'object', additionalProperties: false, required: ['value', 'operator', 'compare'],
              properties: { value: str, operator: { type: 'string', enum: [...OPERATORS] }, compare: str },
            },
          },
        },
      },
      require_approval: { type: 'boolean' },
      questions: { type: 'array', items: str },
    },
  };
}

export const PLANNER_SYSTEM = `You turn a Salesforce admin's request into a CRMagents plan (JSON). Keep it minimal.
Steps run in order. Actions:
- query: read records with SOQL (object, where, limit; fields = the columns the admin wants to see, value empty). No AI, free.
- classify: AI picks one of categories for the record (cheap model). Output: category, reason.
- extract: AI pulls named values out of text. Output: one value per outputs[].name.
- ai_write: AI writes text (summary, reply, note) from data you reference. Output: text.
- research: AI that looks up related Salesforce records itself. Most expensive; only when the data is not on the triggering record. Output: text.
- create_task: Task on the triggering record (subject, message). update_record: set fields on the triggering record. create_record: new record (object, fields). notify_slack: message.
- wait: pause before the next steps (wait_amount, wait_unit), e.g. "if no reply in 3 days" = wait 3 days, then a query/only_if that checks the record again.
- search_knowledge: find matching sections in the company's uploaded documents (support guides, policies). instruction = what to look up, usually the record's own words, e.g. "{record.Subject} {record.Description}". No AI, free. Output: text (numbered sections), sources. A later ai_write automatically gets these sections; tell it what to write (e.g. "troubleshooting steps for this case").
- suggest: show advice on the record's page in Salesforce (subject = short title, message = the text, usually {stepN.text} of an ai_write). Changes nothing in Salesforce, so it needs no approval. Prefer it over update_record when the admin wants a recommendation, suggested reply or next steps "on the case/record".
- web_research: AI searches the internet (company or person background, news, funding, competitors) and writes what it found with sources. instruction = what to find out, e.g. "What does {record.Company} do, how big is it and any recent news?". Output: text. Costs about $0.05 per run.
- read_emails: the email conversation on the case (Email-to-Case). No AI. A later ai_write automatically gets it.
- send_text: SMS or WhatsApp from the company's Twilio number. subject = the phone number (usually {record.MobilePhone} or {record.Phone}), message = the text (often {stepN.text} of an ai_write), object = "whatsapp" for WhatsApp, else SMS. Keep texts short.
- meeting_times: free times on the record owner's Salesforce calendar (or the people in message, emails separated by commas), to offer in an email written by a later ai_write (it gets the list automatically). Output: text (a list of times).
- reply_email: answer the customer by email in the case's thread (message = the reply, usually {stepN.text} of an ai_write). send_now false (default) = a person checks, edits and sends it from the case; true only when the admin clearly wants replies sent automatically.
- read_files: the text of the files attached to the triggering record (PDF, Word, text). No AI. A later ai_write automatically gets it.
- attach_file: save text as a file on the triggering record (subject = file name, message = content, usually {stepN.text}).
- delete_record: delete the triggering record (or the current record inside a per_record query). It goes to the Recycle Bin.
- run_action: run one of the org's own automations listed under "Org actions" (org_action = its key; fields = its inputs as field=input name, value; fill every input marked *). Outputs: the action's listed outputs. Prefer an existing org action over rebuilding the same logic from steps.
References inside text and values: {record.Field} = field of the triggering record, {stepN.key} = output of step N (1-based; a query's results are {stepN.table}), {trigger.input} = free text passed in, {item.Field} = field of the current record inside a per_record query.
Rules:
- "When a customer emails / replies on a case": trigger_object EmailMessage, trigger_event created, condition Incoming equals true; then read_emails, (search_knowledge), ai_write the reply, reply_email.
- When the admin mentions guides, documents, knowledge, SOPs, policies or "our troubleshooting steps": search_knowledge, then ai_write, then suggest (or create_task/update_record if they asked for that).
- Use AI actions only where judgement or writing is needed; prefer query/create_task/update_record otherwise.
- Use conditions to skip records that don't need processing (e.g. closed ones); they mean "run only when all are true" for the whole workflow.
- To make one step conditional, use its only_if (e.g. value "{step1.category}", operator equals, compare "Breakdown"); leave only_if.value empty to always run the step.
- trigger_kind "record" when it reacts to a Salesforce record (created/updated/deleted/button); "schedule" for recurring jobs (every morning, hourly, weekly); "webhook" when another system (a form, ServiceNow, Jira, an app) sends data: its JSON is {trigger.body.key}; "manual" for on-demand questions/reports.
- trigger_event (record only): "created", "updated" (changes to existing records), "created or updated", or "deleted". changed_fields: when the admin says "when Status changes" or "when it is escalated", list those fields (and add a condition for the new value if one is named); empty otherwise.
- To act on each of many records (e.g. "create a task for every stale deal"): a query step with per_record true; the steps after it run once per record. Select the fields you reference ({item.OwnerId} etc.). create_task inside it is linked to that record and assigned to its owner.
- Use only fields from the provided list for the trigger object; for picklists use the listed values exactly.
- require_approval = true unless the admin explicitly says no approval is needed.
- Unused properties: empty string, empty array, or 0.
- If the request is too vague to build, leave steps empty and ask up to 2 short questions.`;
