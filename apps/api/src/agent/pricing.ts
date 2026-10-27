// USD per million tokens, from https://platform.claude.com/docs/en/about-claude/pricing (fetched 2026-10-08).
// Used for the per-run cost estimate and the daily budget guard. Update when prices change.
interface Rates { input: number; cacheWrite5m: number; cacheRead: number; output: number }

const RATES: Record<string, Rates> = {
  'claude-opus-5-5': { input: 4, cacheWrite5m: 5, cacheRead: 0.2, output: 20 },
  'claude-sonnet-5-5': { input: 2, cacheWrite5m: 2.5, cacheRead: 0.1, output: 10 },
  // Haiku 5.5 rates for prompts up to 100k tokens; longer prompts use HAIKU_LONG below.
  'claude-haiku-5-5': { input: 0.1, cacheWrite5m: 0.125, cacheRead: 0.01, output: 0.5 },
};
const HAIKU_LONG: Rates = { input: 0.5, cacheWrite5m: 0.625, cacheRead: 0.05, output: 2.5 };
// Unknown models are priced at the most expensive known rate so the budget errs on the safe side.
const FALLBACK: Rates = RATES['claude-opus-5-5'];

export interface Usage {
  input: number; // uncached input tokens
  cacheWrite: number;
  cacheRead: number;
  output: number;
  costUsd: number;
}

export const emptyUsage = (): Usage => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0, costUsd: 0 });

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheRead: a.cacheRead + b.cacheRead,
    output: a.output + b.output,
    costUsd: a.costUsd + b.costUsd,
  };
}

export function usageFrom(model: string, u: {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  /** Set by the adapter for other AI providers, which price differently. */
  cost_usd?: number;
  server_tool_use?: { web_search_requests?: number } | null;
}): Usage {
  const input = u.input_tokens;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const long = model === 'claude-haiku-5-5' && input + cacheWrite + cacheRead > 100_000;
  const r = long ? HAIKU_LONG : (RATES[model] ?? FALLBACK);
  const output = u.output_tokens;
  const tokens = typeof u.cost_usd === 'number' ? u.cost_usd : (input * r.input + cacheWrite * r.cacheWrite5m + cacheRead * r.cacheRead + output * r.output) / 1_000_000;
  // Web search: $10 per 1,000 searches.
  const costUsd = tokens + (u.server_tool_use?.web_search_requests ?? 0) * 0.01;
  return { input, cacheWrite, cacheRead, output, costUsd };
}

/**
 * What Claude calls would have cost on another model, from the tokens they used: an estimate for choosing the
 * low-cost model first (cache reads are counted as plain input, so it errs high). Pure; tested.
 */
export function costOn(model: string, calls: { model: string; input: number; output: number; costUsd: number }[]) {
  let actual = 0, other = 0;
  for (const c of calls) {
    if (!/^claude-/.test(c.model)) continue; // other providers price their own models
    actual += c.costUsd;
    // Tokens summed over many calls: standard per-token rates (one huge "prompt" would wrongly hit long-prompt pricing).
    const r = RATES[model] ?? FALLBACK;
    other += c.model === model ? c.costUsd : (c.input * r.input + c.output * r.output) / 1_000_000;
  }
  return { actualUsd: actual, onModelUsd: other };
}

export const totalTokens = (u: Usage) => u.input + u.cacheWrite + u.cacheRead + u.output;
