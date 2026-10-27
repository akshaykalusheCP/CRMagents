import { getSetting } from '../settings.js';
import { Masker } from './mask.js';

// Per-workspace trust settings for runs: personal-data masking, per-run limits and which model does the work.

export interface RunLimits { aiCalls: number; toolCalls: number; tokens: number }
export const DEFAULT_LIMITS: RunLimits = { aiCalls: 40, toolCalls: 60, tokens: 400_000 };

const num = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? Number(v) : d);

export async function runTrust(accountId: string, masks?: Record<string, string>) {
  const [on, fields, ai, tools, tokens, route, profile] = await Promise.all([
    getSetting(accountId, 'maskPii'), getSetting(accountId, 'maskFields'),
    getSetting(accountId, 'maxAiCalls'), getSetting(accountId, 'maxToolCalls'), getSetting(accountId, 'maxTokens'),
    getSetting(accountId, 'aiRouting'), getSetting(accountId, 'businessProfile'),
  ]);
  const masker = on === 'off' ? undefined : new Masker(masks ?? {}, (fields ?? '').split(',').map((f) => f.trim()).filter(Boolean));
  const limits: RunLimits = { aiCalls: num(ai, DEFAULT_LIMITS.aiCalls), toolCalls: num(tools, DEFAULT_LIMITS.toolCalls), tokens: num(tokens, DEFAULT_LIMITS.tokens) };
  // Low-cost model first unless the workspace chose the strongest model every time.
  const routing: 'smart' | 'best' = route === 'best' ? 'best' : 'smart';
  return { masker, limits, routing, profile };
}

export class LimitError extends Error {}
