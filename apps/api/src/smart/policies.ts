import { config } from '../config.js';
import { pool } from '../db.js';
import { logSpend, setup } from '../insights/ai.js';
import type { SalesforceClient } from '../salesforce/client.js';

// Workspace rules in plain English ("never email customers on weekends", "don't touch accounts owned by the
// enterprise team"). The AI turns each sentence into a structured rule once; code checks every write against the
// rules before it happens, so enforcement never depends on the model.

export const ACTIONS = ['update', 'create', 'task', 'email', 'message', 'action', 'any'] as const;
export type WriteAction = Exclude<(typeof ACTIONS)[number], 'any'>;
const OPS = ['equals', 'not_equals', 'contains', 'greater_than', 'less_than', 'is_empty', 'not_empty'] as const;

export interface Rule {
  summary: string;
  actions: (typeof ACTIONS)[number][];
  /** Salesforce objects the rule covers; empty = all. */
  objects: string[];
  /** Conditions on the record being changed (all must hold for the rule to apply). Fields may use relationships, e.g. Owner.Name. */
  when: { field: string; operator: (typeof OPS)[number]; value: string }[];
  /** Days the rule applies (0 = Sunday); empty = every day. */
  days: number[];
  /** Hours the rule applies, 24h clock, [from, to); null = all day. */
  hours: { from: number; to: number } | null;
  timezone: string;
}

export interface WriteContext {
  action: WriteAction;
  object: string;
  /** Values being written (create/update). */
  values?: Record<string, unknown>;
  /** The record being changed, with the fields the rules ask about. */
  record?: Record<string, unknown>;
  now?: Date;
}

const get = (o: Record<string, unknown> | undefined, path: string): unknown =>
  path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), o);

function test(left: unknown, op: Rule['when'][number]['operator'], right: string): boolean {
  const l = left === undefined || left === null ? '' : String(left);
  switch (op) {
    case 'equals': return l.toLowerCase() === right.toLowerCase();
    case 'not_equals': return l.toLowerCase() !== right.toLowerCase();
    case 'contains': return l.toLowerCase().includes(right.toLowerCase());
    case 'greater_than': return Number(l) > Number(right);
    case 'less_than': return Number(l) < Number(right);
    case 'is_empty': return l === '';
    case 'not_empty': return l !== '';
  }
}

/** Local weekday and hour in a time zone. */
export function localTime(now: Date, tz: string): { day: number; hour: number } {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(now);
    const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun';
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
    return { day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd), hour };
  } catch { return { day: now.getUTCDay(), hour: now.getUTCHours() }; }
}

/** Does this write break the rule? Pure; tested. */
export function violates(rule: Rule, ctx: WriteContext): boolean {
  if (!rule.actions.includes('any') && !rule.actions.includes(ctx.action)) return false;
  if (rule.objects.length && !rule.objects.some((o) => o.toLowerCase() === ctx.object.toLowerCase())) return false;
  if (rule.days.length || rule.hours) {
    const { day, hour } = localTime(ctx.now ?? new Date(), rule.timezone || 'UTC');
    if (rule.days.length && !rule.days.includes(day)) return false;
    if (rule.hours) {
      const { from, to } = rule.hours;
      const inside = from <= to ? hour >= from && hour < to : hour >= from || hour < to; // overnight windows
      if (!inside) return false;
    }
  }
  const data = { ...(ctx.record ?? {}), ...(ctx.values ?? {}) };
  return rule.when.every((c) => test(get(data, c.field), c.operator, c.value));
}

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['summary', 'actions', 'objects', 'when', 'days', 'hours', 'timezone', 'understood'],
  properties: {
    understood: { type: 'boolean', description: 'false if the sentence is not a rule about what agents may change or send' },
    summary: { type: 'string', description: 'The rule restated in one short sentence starting with "Never" or "Don\'t"' },
    actions: { type: 'array', items: { type: 'string', enum: [...ACTIONS] }, description: 'update/create records, task = create tasks, email = send email, message = Slack/Chatter, action = run Flows/Apex' },
    objects: { type: 'array', items: { type: 'string' }, description: 'Salesforce object API names, e.g. Account, Case; empty for all' },
    when: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['field', 'operator', 'value'], properties: { field: { type: 'string', description: 'API name, relationships allowed (Owner.Name, Account.Type)' }, operator: { type: 'string', enum: [...OPS] }, value: { type: 'string' } } } },
    days: { type: 'array', items: { type: 'integer' }, description: 'Days the rule applies, 0 = Sunday ... 6 = Saturday; empty = every day' },
    hours: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: ['from', 'to'], properties: { from: { type: 'integer', description: '0-23' }, to: { type: 'integer', description: '1-24' } } }] },
    timezone: { type: 'string', description: 'IANA zone if one is mentioned, else the default given' },
  },
};

export async function compileRule(tenantId: string, text: string, defaultTz: string): Promise<Rule> {
  const { llm } = await setup(tenantId);
  const r = await llm.complete({
    system: 'Turn a Salesforce admin\'s rule about what automation must never do into the JSON rule. The rule BLOCKS matching changes.',
    prompt: `Rule: ${text}\nDefault time zone: ${defaultTz}`,
    schema: SCHEMA, model: config.builderModel,
  });
  if (!r.reused) await logSpend(tenantId, 'rule', text.slice(0, 120), r.usage);
  const j = JSON.parse(r.text) as Rule & { understood: boolean };
  if (!j.understood) throw new Error('That does not read like a rule about what agents may do. Try "Never email customers on weekends".');
  try { new Intl.DateTimeFormat('en-US', { timeZone: j.timezone }); } catch { j.timezone = defaultTz; }
  j.days = [...new Set(j.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))];
  if (j.hours && !(j.hours.from >= 0 && j.hours.from <= 23 && j.hours.to >= 0 && j.hours.to <= 24)) j.hours = null;
  const { understood: _u, ...rule } = j;
  return rule;
}

export async function listRules(tenantId: string) {
  const { rows } = await pool.query('select id, text, rule, enabled, created_at from policies where tenant_id=$1 order by created_at', [tenantId]);
  return rows as { id: string; text: string; rule: Rule; enabled: boolean; created_at: string }[];
}

/** A guard for one run: throws before any write that breaks an enabled rule. Fetches record fields only when a rule needs them. */
export async function makeGuard(tenantId: string, sf: SalesforceClient) {
  const rules = (await listRules(tenantId)).filter((r) => r.enabled);
  if (!rules.length) return undefined;
  return async (ctx: WriteContext & { recordId?: string }) => {
    const relevant = rules.filter((r) => violates({ ...r.rule, when: [] }, ctx)); // action/object/time match first
    for (const r of relevant) {
      let record = ctx.record;
      if (r.rule.when.length && !record && ctx.recordId && /^[a-zA-Z0-9]{15,18}$/.test(ctx.recordId)) {
        const fields = [...new Set(r.rule.when.map((c) => c.field))].filter((f) => /^[\w.]+$/.test(f));
        record = (await sf.query(`SELECT ${fields.join(', ')} FROM ${ctx.object} WHERE Id = '${ctx.recordId}'`).catch(() => ({ records: [] }))).records[0] as Record<string, unknown> | undefined;
      }
      if (violates(r.rule, { ...ctx, record })) throw new Error(`Blocked by workspace rule: ${r.rule.summary}`);
    }
  };
}
