import { withAiLog, type AiContext } from '../trust/aiLog.js';
import type Anthropic from '@anthropic-ai/sdk';
import { getSetting } from '../settings.js';
import { anthropicClient } from './llm.js';

// Which AI a workspace uses. Claude is the default. Workspaces can instead bring their own OpenAI, Google Gemini
// or any OpenAI-compatible service (Azure OpenAI, Mistral, DeepSeek, a model they host). The rest of CRMagents
// always speaks the Messages API shape; for other providers the adapter below translates each request and reply,
// so tools, structured answers, masking, limits and budgets work the same everywhere.

export type Provider = 'anthropic' | 'openai' | 'gemini' | 'compatible';
export type AiClient = Pick<Anthropic, 'messages'>;

const BASE_URLS: Record<Exclude<Provider, 'anthropic' | 'compatible'>, string> = {
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
};

const missing = (what: string) => Object.assign(new Error(`${what} is not configured. Add it in Settings → AI & spending.`), { statusCode: 400 });

/** The AI client for a workspace, or a clear error when its key is missing. */
/** The workspace's AI client. Every call through it is recorded in the AI call log (trust/aiLog.ts). */
export async function aiClient(accountId: string, ctx: AiContext = {}): Promise<AiClient> {
  const provider = ((await getSetting(accountId, 'aiProvider')) || 'anthropic') as Provider;
  return withAiLog(await rawClient(accountId, provider), accountId, provider, ctx);
}

async function rawClient(accountId: string, provider: Provider): Promise<AiClient> {
  if (provider === 'anthropic') {
    const key = await getSetting(accountId, 'anthropicKey');
    if (!key) throw missing('Anthropic API key');
    return anthropicClient(key, await getSetting(accountId, 'anthropicWorkspaceId'));
  }
  const key = await getSetting(accountId, 'providerKey');
  if (!key) throw missing('The AI provider\'s API key');
  const baseUrl = provider === 'compatible' ? await getSetting(accountId, 'aiBaseUrl') : BASE_URLS[provider];
  if (!baseUrl) throw missing('The AI provider\'s base URL');
  const model = await getSetting(accountId, 'aiModel');
  if (!model) throw missing('The model name');
  return openAiCompatible({
    baseUrl, key, model,
    fastModel: (await getSetting(accountId, 'aiFastModel')) || model,
    priceIn: Number(await getSetting(accountId, 'aiPriceIn')) || 5,
    priceOut: Number(await getSetting(accountId, 'aiPriceOut')) || 15,
  });
}

export interface CompatOptions {
  baseUrl: string; key: string;
  /** Used where CRMagents would use its default model. */
  model: string;
  /** Used where CRMagents would pick its low-cost model (e.g. sorting into categories). */
  fastModel: string;
  /** USD per million input / output tokens, for spend tracking and budgets. */
  priceIn: number; priceOut: number;
  fetchImpl?: typeof fetch;
}

type Block = { type: string; [k: string]: any };

/** Messages API request -> Chat Completions request. Pure; tested. */
export function toChat(req: any, o: Pick<CompatOptions, 'model' | 'fastModel'>) {
  const text = (c: unknown): string => (typeof c === 'string' ? c : (c as Block[]).filter((b) => b.type === 'text').map((b) => b.text).join('\n'));
  const messages: any[] = [];
  const system = req.system ? text(req.system) : '';
  if (system) messages.push({ role: 'system', content: system });
  for (const m of req.messages as { role: string; content: string | Block[] }[]) {
    if (typeof m.content === 'string') { messages.push({ role: m.role, content: m.content }); continue; }
    if (m.role === 'assistant') {
      const calls = m.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      messages.push({ role: 'assistant', content: text(m.content) || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    for (const b of m.content.filter((x) => x.type === 'tool_result')) {
      messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: `${b.is_error ? 'ERROR: ' : ''}${text(b.content ?? '')}` });
    }
    const t = text(m.content);
    if (t) messages.push({ role: 'user', content: t });
  }
  const fast = /haiku/i.test(String(req.model ?? ''));
  const schema = req.output_config?.format?.schema;
  return {
    model: fast ? o.fastModel : o.model,
    messages,
    max_completion_tokens: req.max_tokens,
    // Claude's own server tools (web search) have no equivalent here and are left out.
    ...(req.tools?.some((t: any) => t.input_schema) ? { tools: req.tools.filter((t: any) => t.input_schema).map((t: any) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })) } : {}),
    ...(schema ? { response_format: { type: 'json_schema', json_schema: { name: 'answer', schema, strict: false } } } : {}),
  };
}

const STOP: Record<string, string> = { tool_calls: 'tool_use', function_call: 'tool_use', length: 'max_tokens', content_filter: 'refusal', stop: 'end_turn' };

/** Chat Completions reply -> Messages API reply (with the cost in USD). Pure; tested. */
export function fromChat(r: any, o: Pick<CompatOptions, 'priceIn' | 'priceOut'>) {
  const msg = r.choices?.[0]?.message ?? {};
  const content: Block[] = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  for (const c of msg.tool_calls ?? []) {
    let input: unknown = {};
    try { input = JSON.parse(c.function?.arguments || '{}'); } catch { input = {}; }
    content.push({ type: 'tool_use', id: c.id, name: c.function?.name, input });
  }
  const cached = r.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const input = Math.max(0, (r.usage?.prompt_tokens ?? 0) - cached);
  const output = r.usage?.completion_tokens ?? 0;
  return {
    id: r.id, type: 'message', role: 'assistant', model: r.model, content,
    stop_reason: msg.tool_calls?.length ? 'tool_use' : (STOP[r.choices?.[0]?.finish_reason] ?? 'end_turn'),
    usage: {
      input_tokens: input, output_tokens: output, cache_read_input_tokens: cached, cache_creation_input_tokens: 0,
      // Read by usageFrom: providers price differently from Claude.
      cost_usd: ((input + cached) * o.priceIn + output * o.priceOut) / 1_000_000,
    },
  };
}

export function openAiCompatible(o: CompatOptions): AiClient {
  const f = o.fetchImpl ?? fetch;
  return {
    messages: {
      create: (async (req: any) => {
        const res = await f(`${o.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${o.key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(toChat(req, o)),
        });
        const body = await res.text();
        if (!res.ok) throw Object.assign(new Error(`AI provider error ${res.status}: ${body.slice(0, 400)}`), { status: res.status });
        return fromChat(JSON.parse(body), o);
      }) as any,
    } as AiClient['messages'],
  };
}
