import { getSetting } from '../settings.js';
import { Masker } from './mask.js';

// Per-workspace trust settings for runs: personal-data masking and per-run limits.

export interface RunLimits { aiCalls: number; toolCalls: number; tokens: number }
export const DEFAULT_LIMITS: RunLimits = { aiCalls: 40, toolCalls: 60, tokens: 400_000 };

const num = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? Number(v) : d);

export async function runTrust(accountId: string, masks?: Record<string, string>) {
  const [on, fields, ai, tools, tokens] = await Promise.all([
    getSetting(accountId, 'maskPii'), getSetting(accountId, 'maskFields'),
    getSetting(accountId, 'maxAiCalls'), getSetting(accountId, 'maxToolCalls'), getSetting(accountId, 'maxTokens'),
  ]);
  const masker = on === 'off' ? undefined : new Masker(masks ?? {}, (fields ?? '').split(',').map((f) => f.trim()).filter(Boolean));
  const limits: RunLimits = { aiCalls: num(ai, DEFAULT_LIMITS.aiCalls), toolCalls: num(tools, DEFAULT_LIMITS.toolCalls), tokens: num(tokens, DEFAULT_LIMITS.tokens) };
  return { masker, limits };
}

export class LimitError extends Error {}
