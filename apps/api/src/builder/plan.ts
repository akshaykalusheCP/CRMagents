// The compact plan the AI writes for a plain-English request. Code (compile.ts) turns it into a full workflow,
// so the model only spends tokens on understanding the request, not on wiring blocks together.

export const OPERATORS = ['equals', 'not_equals', 'contains', 'greater_than', 'less_than', 'is_empty', 'not_empty'] as const;
export const ACTIONS = ['classify', 'extract', 'ai_write', 'research', 'query', 'create_task', 'update_record', 'create_record', 'notify_slack', 'run_action'] as const;

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
}

export interface Plan {
  name: string;
  trigger_kind: 'record' | 'manual' | 'schedule';
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
    required: ['name', 'trigger_kind', 'trigger_object', 'schedule', 'conditions', 'steps', 'require_approval', 'questions'],
    properties: {
      name: { type: 'string', description: 'Short workflow name' },
      trigger_kind: { type: 'string', enum: ['record', 'manual', 'schedule'] },
      schedule: {
        type: 'object', additionalProperties: false, required: ['every', 'at'],
        properties: { every: { type: 'string', enum: ['hour', 'day', 'week'] }, at: { type: 'string', description: 'HH:MM in UTC; "08:00" if not given' } },
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
          required: ['action', 'instruction', 'input_fields', 'categories', 'outputs', 'object', 'fields', 'subject', 'message', 'where', 'limit', 'only_if', 'per_record', 'org_action'],
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
- run_action: run one of the org's own automations listed under "Org actions" (org_action = its key; fields = its inputs as field=input name, value; fill every input marked *). Outputs: the action's listed outputs. Prefer an existing org action over rebuilding the same logic from steps.
References inside text and values: {record.Field} = field of the triggering record, {stepN.key} = output of step N (1-based), {trigger.input} = free text passed in, {item.Field} = field of the current record inside a per_record query.
Rules:
- Use AI actions only where judgement or writing is needed; prefer query/create_task/update_record otherwise.
- Use conditions to skip records that don't need processing (e.g. closed ones); they mean "run only when all are true" for the whole workflow.
- To make one step conditional, use its only_if (e.g. value "{step1.category}", operator equals, compare "Breakdown"); leave only_if.value empty to always run the step.
- trigger_kind "record" when it reacts to a Salesforce record (created/updated/button); "schedule" for recurring jobs (every morning, hourly, weekly); "manual" for on-demand questions/reports.
- To act on each of many records (e.g. "create a task for every stale deal"): a query step with per_record true; the steps after it run once per record. Select the fields you reference ({item.OwnerId} etc.). create_task inside it is linked to that record and assigned to its owner.
- Use only fields from the provided list for the trigger object; for picklists use the listed values exactly.
- require_approval = true unless the admin explicitly says no approval is needed.
- Unused properties: empty string, empty array, or 0.
- If the request is too vague to build, leave steps empty and ask up to 2 short questions.`;
