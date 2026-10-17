import { AsyncLocalStorage } from 'node:async_hooks';
import { pool } from '../db.js';
import { usageFrom } from '../agent/pricing.js';
import type { AiClient } from '../agent/provider.js';

// The AI call log: every request to the AI provider, exactly as it was sent (after masking), and its reply.
// It's how a workspace can check for itself what the AI saw. Recorded at the one place every call goes through
// (the provider client), kept as long as run details are (the workspace's retention setting).
// Large pieces are cut to keep the log readable; nothing is added that wasn't sent.

export interface AiContext { tenantId?: string | null; runId?: string | null; purpose?: string }
export const aiContext = new AsyncLocalStorage<AiContext>();

const TEXT = 8000, TOOL_RESULT = 4000, SYSTEM = 20000;
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… [${s.length - n} more characters]` : s);
const str = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v) ?? '');

/** A request or reply in a readable, size-limited form. Pure; tested. */
export function readable(content: unknown): unknown {
  if (typeof content === 'string') return cut(content, TEXT);
  if (!Array.isArray(content)) return cut(str(content), TEXT);
  return content.map((b: any) => {
    switch (b?.type) {
      case 'text': return { text: cut(String(b.text ?? ''), TEXT) };
      case 'tool_use': return { tool: b.name, input: cut(str(b.input), TOOL_RESULT) };
      case 'tool_result': return { result: cut(str(b.content), TOOL_RESULT) };
      case 'document': return { document: `${b.source?.media_type ?? 'file'} (not stored here)` };
      case 'image': return { image: '(not stored here)' };
      case 'server_tool_use': return { tool: b.name, input: cut(str(b.input), TOOL_RESULT) };
      case 'web_search_tool_result': return { webResults: Array.isArray(b.content) ? b.content.length : 0 };
      default: return { [b?.type ?? 'part']: '(not shown)' };
    }
  });
}

/** Personal values replaced by placeholders like [EMAIL_1] in what was sent. Pure; tested. */
export function maskedCount(request: unknown): number {
  return new Set(str(request).match(/\[[A-Z][A-Za-z0-9_]*_\d+\]/g) ?? []).size;
}

export async function logAiCall(accountId: string, provider: string, c: AiContext, r: {
  model: string; request: unknown; response?: unknown; usage?: { input: number; output: number; costUsd: number }; ms: number; error?: string;
}) {
  await pool.query(
    `insert into ai_calls (account_id, tenant_id, run_id, purpose, provider, model, request, response, masked_values, input_tokens, output_tokens, cost_usd, ms, error)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [accountId, c.tenantId ?? null, c.runId ?? null, c.purpose ?? null, provider, r.model, JSON.stringify(r.request), r.response === undefined ? null : JSON.stringify(r.response),
      maskedCount(r.request), r.usage?.input ?? 0, r.usage?.output ?? 0, r.usage?.costUsd ?? 0, r.ms, r.error?.slice(0, 2000) ?? null],
  ).catch(() => undefined); // the log never breaks the call it records
}

/** Wrap a provider client so every messages.create is recorded. */
export function withAiLog(client: AiClient, accountId: string, provider: string, fallback: AiContext = {}): AiClient {
  const messages = client.messages;
  const create = async (params: any, options?: any) => {
    const ctx = { ...fallback, ...(aiContext.getStore() ?? {}) };
    const request = {
      system: typeof params.system === 'string' ? cut(params.system, SYSTEM) : readable(params.system),
      messages: (params.messages ?? []).map((m: any) => ({ role: m.role, content: readable(m.content) })),
      tools: (params.tools ?? []).map((t: any) => t.name),
    };
    const t0 = Date.now();
    try {
      const res: any = await (messages.create as any)(params, options);
      const u = usageFrom(params.model, res.usage ?? {});
      void logAiCall(accountId, provider, ctx, { model: params.model, request, response: { stop: res.stop_reason, content: readable(res.content) }, usage: { input: u.input + u.cacheRead + u.cacheWrite, output: u.output, costUsd: u.costUsd }, ms: Date.now() - t0 });
      return res;
    } catch (e) {
      void logAiCall(accountId, provider, ctx, { model: params.model, request, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  };
  const wrapped = new Proxy(messages, { get: (t, p) => (p === 'create' ? create : (t as any)[p]) });
  return { messages: wrapped } as AiClient;
}

export async function listAiCalls(accountId: string, o: { runId?: string; limit?: number } = {}) {
  const { rows } = await pool.query(
    `select c.id, c.created_at as "createdAt", c.provider, c.model, c.masked_values as "maskedValues", c.input_tokens as "inputTokens",
            c.output_tokens as "outputTokens", c.cost_usd::float as "costUsd", c.ms, c.error, c.run_id as "runId",
            coalesce(c.purpose, w.name, a.name, case when r.input ? 'insights' then 'Insights' end, 'Other') as purpose
     from ai_calls c left join runs r on r.id = c.run_id left join workflows w on w.id = r.workflow_id left join agents a on a.id = r.agent_id
     where c.account_id=$1 and ($2::uuid is null or c.run_id=$2) order by c.created_at desc limit $3`,
    [accountId, o.runId ?? null, Math.min(o.limit ?? 100, 500)]);
  return rows;
}

export async function getAiCall(accountId: string, id: number) {
  const { rows } = await pool.query('select id, created_at as "createdAt", provider, model, request, response, masked_values as "maskedValues", error from ai_calls where account_id=$1 and id=$2', [accountId, id]);
  if (!rows[0]) throw Object.assign(new Error('Not found'), { statusCode: 404 });
  return rows[0];
}
