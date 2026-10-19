import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compilePlan } from '../builder/compile.js';
import type { Plan, PlanStep } from '../builder/plan.js';
import { execute, newState } from '../engine/executor.js';
import type { Env } from '../engine/nodes.js';
import { emailHtml, stripQuoted } from './email.js';

test('emails: quoted history is cut, replies become safe HTML', () => {
  assert.equal(stripQuoted('Still broken.\n\nOn Mon, 12 Oct 2026 at 10:00, Support <s@x.com> wrote:\n> Try restarting'), 'Still broken.');
  assert.equal(stripQuoted('Thanks!\n> old line\nBye'), 'Thanks!\nBye');
  assert.equal(stripQuoted('Hi\n-----Original Message-----\nFrom: a@b.com'), 'Hi');
  assert.equal(emailHtml('Hi Ana,\n\n- **Restart** it\n- Check <cables>\n\nThanks'), '<p>Hi Ana,</p><ul><li><b>Restart</b> it</li><li>Check &lt;cables&gt;</li></ul><p>Thanks</p>');
});

const step = (s: Partial<PlanStep> & Pick<PlanStep, 'action'>): PlanStep => ({
  instruction: '', input_fields: [], categories: [], outputs: [], object: '', fields: [], subject: '', message: '', where: '', limit: 0,
  only_if: { value: '', operator: 'equals', compare: '' }, per_record: false, ...s,
});
const plan = (sendNow: boolean): Plan => ({
  name: 'Email replies', trigger_kind: 'record', trigger_object: 'EmailMessage', trigger_event: 'created', changed_fields: [], schedule: { every: 'day', at: '08:00' },
  conditions: [{ field: 'Incoming', operator: 'equals', value: 'true' }], require_approval: true, questions: [],
  steps: [step({ action: 'read_emails' }), step({ action: 'ai_write', instruction: 'Write a short, friendly reply to the customer' }), step({ action: 'reply_email', send_now: sendNow })],
});

test('email reply agent: suggestions need no approval, sending does; the AI sees the conversation', () => {
  const suggest = compilePlan(plan(false));
  assert.deepEqual(suggest.errors, []);
  assert.ok(!suggest.workflow.nodes.some((n) => n.type === 'logic.approval'));
  assert.match(String(suggest.workflow.nodes.find((n) => n.type === 'ai.agent')!.config.prompt), /Email conversation \(newest last\):\n\{\{emails_1\.text\}\}/);
  assert.equal(suggest.workflow.nodes.find((n) => n.type === 'sf.emailReply')!.config.mode, 'suggest');
  const send = compilePlan(plan(true));
  assert.ok(send.workflow.nodes.some((n) => n.type === 'logic.approval'));
  assert.equal(send.workflow.nodes.find((n) => n.type === 'sf.emailReply')!.config.mode, 'send');
});

test('email reply runs: reads the thread from the email that started it, then sends in that thread', async () => {
  const wf = compilePlan(plan(true)).workflow;
  const actions: any[] = [];
  let prompt = '';
  const env = {
    sf: {
      getRecord: async () => ({ Incoming: true }),
      query: async (soql: string) => {
        if (soql.includes('SELECT Incoming FROM EmailMessage')) return { records: [{ Incoming: true }] };
        if (soql.includes('SELECT ParentId FROM EmailMessage')) return { records: [{ ParentId: '500CASE' }] };
        return { records: [
          { Id: '02sB', FromAddress: 'ana@example.com', Incoming: true, MessageDate: '2026-10-16T10:00:00Z', Subject: 'Printer offline', TextBody: 'It stopped.\n> quoted' },
          { Id: '02sA', FromAddress: 'support@acme.com', Incoming: false, MessageDate: '2026-10-15T10:00:00Z', Subject: 'Re: Printer', TextBody: 'Try a restart' },
        ] };
      },
      runAction: async (...a: any[]) => (actions.push(a), { sent: true }),
    },
    llm: { agent: async (o: any) => { prompt = o.prompt; return { text: 'Hi Ana, please check the cable.', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0 }, trace: [] }; }, complete: async () => { throw new Error('x'); } },
  } as unknown as Env;
  const st = newState({ recordId: '02sB000000000AB', objectApiName: 'EmailMessage' });
  let out = await execute(wf, env, st);
  assert.equal(out.status, 'waiting'); // approval before sending
  st.decision = { nodeId: st.pending!, approve: true };
  out = await execute(wf, env, st);
  assert.equal(out.status, 'done', out.error);
  assert.match(prompt, /Customer \(ana@example\.com.*\): Printer offline\nIt stopped\./s);
  assert.ok(prompt.indexOf('Try a restart') < prompt.indexOf('It stopped.')); // oldest first
  const [kind, name, inputs] = actions[0];
  assert.deepEqual([kind, name, inputs.caseId, inputs.toAddress, inputs.subject, inputs.inReplyToId], ['apex', 'CRMCaseEmail', '500CASE', 'ana@example.com', 'Re: Printer offline', '02sB000000000AB']);
  assert.equal(inputs.htmlBody, '<p>Hi Ana, please check the cable.</p>');
});

test('email agents only answer incoming emails, even when the plan forgot to say so', async () => {
  const p = plan(false);
  p.conditions = [{ field: 'Id', operator: 'not_empty', value: '' }];
  const c = compilePlan(p);
  const branch = c.workflow.nodes.find((n) => n.type === 'logic.branch')!;
  assert.equal(branch.config.left, '{{sf_get_1.record.Incoming}}');
  assert.equal(branch.config.right, 'true');
  // And the reply step itself refuses to answer an outgoing email.
  const env = {
    sf: { query: async () => ({ records: [{ Incoming: false }] }), runAction: async () => { throw new Error('must not send'); } },
    llm: {}, run: { tenantId: 't', runId: 'r' },
  } as unknown as Env;
  const wf = { nodes: [
    { id: 't', type: 'trigger.salesforce', position: { x: 0, y: 0 }, config: { objectApiName: 'EmailMessage' } },
    { id: 'r', type: 'sf.emailReply', position: { x: 0, y: 0 }, config: { recordId: '{{trigger.recordId}}', body: 'Hi', mode: 'send' } },
  ], edges: [{ id: 'e', source: 't', target: 'r' }] };
  const st = newState({ recordId: '02sOUT000000000AA' });
  const out = await execute(wf, env, st);
  assert.equal(out.status, 'done');
  assert.match(JSON.stringify(st.steps), /Not a customer email/);
});

test('explainSalesforceError: common Salesforce failures read in plain English', async () => {
  const { explainSalesforceError: x } = await import('./client.js');
  assert.match(x('[{"actionName":"submit","errors":[{"statusCode":"NO_APPLICABLE_PROCESS","message":"No applicable approval process was found."}]}]') ?? '', /No approval process in Salesforce matches/);
  assert.equal(x('[{"message":"Close date must be in the future","errorCode":"FIELD_CUSTOM_VALIDATION_EXCEPTION","fields":[]}]'), 'A validation rule in Salesforce blocked this change: "Close date must be in the future".');
  assert.match(x('[{"message":"Required fields are missing: [StageName]","errorCode":"REQUIRED_FIELD_MISSING","fields":["StageName"]}]') ?? '', /required field \(StageName\)/);
  assert.match(x('[{"message":"insufficient access rights on object id","errorCode":"INSUFFICIENT_ACCESS_OR_READONLY"}]') ?? '', /isn't allowed/);
  assert.equal(x('something else'), undefined);
});
