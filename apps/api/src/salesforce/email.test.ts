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
