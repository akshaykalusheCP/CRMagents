import { config } from '../config.js';
import { logSpend, setup } from '../insights/ai.js';
import { listOrgActions, rankActions } from '../salesforce/actions.js';
import { detectObjects, objects as listObjects } from '../salesforce/schema.js';
import type { Plan } from './plan.js';
import { draftWorkflow, type Draft } from './service.js';

// Build an agent by chatting. A cheap model asks at most two short questions (with tap-to-answer options) when
// something essential is missing, then the existing builder writes, compiles and validates the agent. Changes to a
// built agent go straight to the builder in "change" mode: no extra call.

export interface ChatMsg { role: 'user' | 'assistant'; text: string }
export interface ChatReply { reply: string; question?: string; options?: string[]; request?: string; draft?: Draft; costUsd: number }

export const MAX_QUESTIONS = 2;

const CLARIFY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['ready', 'request', 'question', 'options'],
  properties: {
    ready: { type: 'boolean', description: 'true when there is enough to build' },
    request: { type: 'string', description: 'When ready: the complete spec in 1-3 plain sentences, combining every answer' },
    question: { type: 'string', description: 'When not ready: ONE short question (max 15 words)' },
    options: { type: 'array', items: { type: 'string' }, description: '2-4 short answers the admin can tap (max 6 words each)' },
  },
};

const CLARIFY_SYSTEM = `You help a Salesforce admin describe an automation agent. Decide if the request is clear enough to build.
Essential: which records it works on, what starts it (a record is created/updated, a schedule, or on demand), and what it should do.
If one of these is truly missing or ambiguous, ask ONE short question with 2-4 tap-able answers. Never ask about things with a sensible default (approval, wording, models).
If an org action listed below clearly fits, you may ask whether to use it (e.g. "Use your Flow 'Close Case'?" with Yes / No).
When clear: ready = true and request = the full spec in plain words, including every answer given.`;

/** How many questions the assistant already asked in this conversation. Pure; tested. */
export const questionsAsked = (messages: ChatMsg[]) => messages.filter((m) => m.role === 'assistant' && m.text.trim().endsWith('?')).length;

export async function builderChat(tenantId: string, messages: ChatMsg[], current?: Plan, timezone?: string): Promise<ChatReply> {
  const users = messages.filter((m) => m.role === 'user').map((m) => m.text.trim()).filter(Boolean);
  const last = users[users.length - 1];
  if (!last) throw new Error('Say what the agent should do');

  // Already built: the message is a change ("also email the owner").
  if (current) {
    const draft = await draftWorkflow(tenantId, last, current, timezone);
    return { reply: draft.errors.length ? 'I changed it, but something still needs a fix (see below).' : 'Updated. Review the agent card.', draft, costUsd: draft.builderCostUsd };
  }

  let request = users.join('\n');
  let cost = 0;
  if (questionsAsked(messages) < MAX_QUESTIONS) {
    const { llm, sf } = await setup(tenantId);
    const all = await listObjects(tenantId, sf);
    const { mentioned, candidates } = detectObjects(request, all);
    const actions = rankActions(request, await listOrgActions(tenantId, sf).catch(() => []), 5);
    const prompt = [
      `Conversation:\n${messages.map((m) => `${m.role === 'user' ? 'Admin' : 'You'}: ${m.text}`).join('\n')}`,
      `Objects that may be relevant: ${[...new Set([...mentioned, ...candidates])].slice(0, 8).join(', ') || 'none detected'}`,
      actions.length ? `Org actions that may fit: ${actions.map((a) => `${a.label} (${a.kind})`).join('; ')}` : '',
    ].filter(Boolean).join('\n\n');
    const r = await llm.complete({ system: CLARIFY_SYSTEM, prompt, schema: CLARIFY_SCHEMA, model: config.builderModel });
    cost += r.usage.costUsd;
    if (!r.reused) await logSpend(tenantId, 'builder chat', last, r.usage);
    // Non-Claude providers may leave fields out: treat missing ones as empty.
    const raw = JSON.parse(r.text) as Partial<{ ready: boolean; request: string; question: string; options: string[] }>;
    const question = typeof raw.question === 'string' ? raw.question.trim() : '';
    const options = Array.isArray(raw.options) ? raw.options.filter((o): o is string => typeof o === 'string') : [];
    if (!raw.ready && question) {
      const q = question.replace(/[^?]$/, '$&?');
      return { reply: q, question: q, options: options.slice(0, 4), costUsd: cost };
    }
    if (typeof raw.request === 'string' && raw.request.trim()) request = raw.request.trim();
  }

  const draft = await draftWorkflow(tenantId, request, undefined, timezone);
  cost += draft.builderCostUsd;
  if (!draft.workflow.nodes.length || (draft.questions.length && !draft.plan.steps.length)) {
    const q = draft.questions[0] ?? 'What should the agent do?';
    return { reply: q, question: q, options: [], request, costUsd: cost };
  }
  return {
    reply: draft.errors.length ? `I built "${draft.name}", but something needs a fix (see below).` : `Built "${draft.name}". Review the agent card, then try it on real records.`,
    request, draft, costUsd: cost,
  };
}
